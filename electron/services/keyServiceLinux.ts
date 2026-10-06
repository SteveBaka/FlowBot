import { app } from 'electron'
import { join, basename } from 'path'
import { existsSync, readdirSync, statSync, readFileSync, readlinkSync, chmodSync } from 'fs'
import { execFile, exec, spawn } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import { attestService } from './attestService'
import { logger } from './logger'
import { createRequire } from 'module';
const require = createRequire(__filename);

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }

// Hook 模式的单次等待窗口：刻意保持较短，缩短微信处于「被 ptrace 追踪」状态的时间，
// 降低账号风险；窗口结束后由前端决策「继续等待（重新监听）」或取消。
const HOOK_WINDOW_MS = 30_000

/** 密钥流程结构化日志（file-only，落 /opt/weflow/data/logs/keyflow.log，不污染 stdout） */
function kf(msg: string): void {
  try { logger.info('keyflow', msg) } catch { /* ignore */ }
}

export class KeyServiceLinux {
  private sudo: any
  /** 当前运行的 Hook 子进程取消器（用于「取消」时立即结束 helper，避免残留进程） */
  private activeHookKill: (() => void) | null = null

  constructor() {
    try {
      this.sudo = require('@vscode/sudo-prompt');
    } catch (e) {
      console.error('Failed to load @vscode/sudo-prompt', e);
    }
  }

  private getHelperPath(): string {
    const isPackaged = app.isPackaged
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates: string[] = []
    if (process.env.WX_KEY_HELPER_PATH) candidates.push(process.env.WX_KEY_HELPER_PATH)
    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'xkey_helper_linux'))
    } else {
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), '..', 'Xkey', 'build', 'xkey_helper_linux'))
    }
    for (const p of candidates) {
      if (existsSync(p)) {
        try { chmodSync(p, 0o755) } catch {}
        return p
      }
    }
    throw new Error('找不到 xkey_helper_linux，请检查路径')
  }

  public async autoGetDbKey(
      timeoutMs = 120_000,
      onStatus?: (message: string, level: number) => void,
      options?: { mode?: 'hook' | 'restart' }
  ): Promise<DbKeyResult> {
    const mode: 'hook' | 'restart' = options?.mode === 'restart' ? 'restart' : 'hook'
    try {
      // db_runner 强制一次性即时校验（仅在我们的容器环境生效）：当场握手，未通过则禁用，
      // 且不做任何 kill/拉起。该校验独立于 24H 租期，属敏感操作的强约束。
      if (process.env.WEFLOW_DOCKER === '1') {
        const ok = await attestService.verifyNow()
        kf(`gate mode=${mode} attest=${ok ? 'pass' : 'block'}`)
        if (!ok) {
          const err = '本地认证异常：密钥获取功能已暂停（请确认 WebUI 管理面板在线）'
          onStatus?.(err, 2)
          return { success: false, error: err }
        }
      }
      // 1. 构造一个包含常用系统命令路径的环境变量，防止打包后找不到命令
      const envWithPath = {
        ...process.env,
        PATH: `${process.env.PATH || ''}:/bin:/usr/bin:/sbin:/usr/sbin:/usr/local/bin`
      };

      // ── Hook 模式（实验性）：不结束微信进程，装 Hook 等待一次登录事件 ──
      // 密钥只在派生（登录）瞬间存在、不驻留内存，故必须在登录前装好 Hook。
      // 已登录且无新登录事件时会超时，此时由前端决策，不再静默重启微信。
      if (mode === 'hook') {
        // 单次窗口封顶 30s，缩短微信被追踪时长；超时由前端决定是否重新监听
        const hookWaitMs = Math.min(timeoutMs, HOOK_WINDOW_MS)
        const runningPids = this.discoverWechatPids()
        if (runningPids.length > 0) {
          onStatus?.('检测到微信已在运行，正在安装密钥 Hook（无需退出微信）...', 0)
          return await this.getDbKey(runningPids[0], onStatus, hookWaitMs)
        }
        onStatus?.('未检测到微信进程，正在启动微信...', 0)
        this.launchWeChat()
        const hookPid = await this.waitForWechatPid(onStatus)
        if (!hookPid) {
          const err = '未能自动启动微信，请手动启动微信并停留在登录界面后重试'
          onStatus?.(err, 2)
          return { success: false, error: err }
        }
        await new Promise(r => setTimeout(r, 2000))
        return await this.getDbKey(hookPid, onStatus, hookWaitMs)
      }

      // ── 原有方式：结束微信进程 → 重新拉起 → Hook ──
      onStatus?.('正在尝试结束当前微信进程...', 0)
      console.log('[Debug] 开始执行进程清理逻辑...');

      try {
        const { stdout, stderr } = await execAsync('killall -9 wechat wechat-bin xwechat', { env: envWithPath });
        console.log(`[Debug] killall 成功退出. stdout: ${stdout}, stderr: ${stderr}`);
      } catch (err: any) {
        // 命令如果没找到进程通常会返回 code 1，这也是正常的，但我们需要记录下来
        console.log(`[Debug] killall 报错或未找到进程: ${err.message}`);

        // Fallback: 尝试使用 pkill 兜底
        try {
          console.log('[Debug] 尝试使用备用命令 pkill...');
          await execAsync('pkill -9 -x "wechat|wechat-bin|xwechat"', { env: envWithPath });
          console.log('[Debug] pkill 执行完成');
        } catch (e: any) {
          console.log(`[Debug] pkill 报错或未找到进程: ${e.message}`);
        }
      }

      // 稍微等待进程完全退出
      await new Promise(r => setTimeout(r, 1000))

      onStatus?.('正在尝试拉起微信...', 0)

      this.launchWeChat()

      const pid = await this.waitForWechatPid(onStatus)

      if (!pid) {
        const err = '未能自动启动微信，或获取PID失败，请查看控制台日志或手动启动微信，看到登录窗口后点击确认。'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      onStatus?.(`捕获到微信 PID: ${pid}，准备获取密钥...`, 0)

      await new Promise(r => setTimeout(r, 2000))

      return await this.getDbKey(pid, onStatus, timeoutMs)
    } catch (err: any) {
      console.error('[Debug] 自动获取流程彻底崩溃:', err);
      const errMsg = '自动获取微信 PID 失败: ' + err.message
      onStatus?.(errMsg, 2)
      return { success: false, error: errMsg }
    }
  }

  /** 取消正在进行的 Hook：立即结束 helper 并让本次调用返回（不残留进程） */
  public cancelDbKeyHook(): void {
    try { this.activeHookKill?.() } catch { /* ignore */ }
  }

  /** 拉起微信（fire-and-forget，遍历常见可执行名；不结束已有进程） */
  private launchWeChat(): void {
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE;
    delete cleanEnv.APPDIR;
    delete cleanEnv.APPIMAGE;

    const wechatBins = [
      'wechat',
      'wechat-bin',
      'xwechat',
      '/opt/wechat/wechat',
      '/usr/bin/wechat',
      '/usr/local/bin/wechat',
      '/usr/bin/wechat',
      '/opt/apps/com.tencent.wechat/files/wechat',
      '/usr/bin/wechat-bin',
      '/usr/local/bin/wechat-bin',
      'com.tencent.wechat'
    ]

    for (const binName of wechatBins) {
      try {
        const child = spawn(binName, [], {
          detached: true,
          stdio: 'ignore',
          env: cleanEnv
        });

        child.on('error', (err) => {
          console.log(`[Debug] 拉起 ${binName} 失败:`, err.message);
        });

        child.unref();
        console.log(`[Debug] 尝试拉起 ${binName} 完毕`);
      } catch (e: any) {
        console.log(`[Debug] 尝试拉起 ${binName} 发生异常:`, e.message);
      }
    }
  }

  /** 等待微信进程出现，最多 15 秒，返回首个 PID（0 表示未出现） */
  private async waitForWechatPid(onStatus?: (message: string, level: number) => void): Promise<number> {
    onStatus?.('等待微信进程出现...', 0)
    for (let i = 0; i < 15; i++) { // 最多等 15 秒
      await new Promise(r => setTimeout(r, 1000))
      try {
        const pids = this.discoverWechatPids();
        if (pids.length > 0) {
          console.log(`[Debug] 第 ${i + 1} 秒，通过 /proc 扫描成功获取 PID: ${pids[0]}`);
          return pids[0];
        }
      } catch (err: any) {
        console.log(`[Debug] 第 ${i + 1} 秒，/proc 扫描失败: ${err.message.split('\n')[0]}`);
      }
    }
    return 0
  }

  public async getDbKey(pid: number, onStatus?: (message: string, level: number) => void, timeoutMs = 180_000): Promise<DbKeyResult> {
    try {
      // 二次防线（廉价，不额外握手）：认证不可用则拒绝
      if (process.env.WEFLOW_DOCKER === '1' && !attestService.isUsable()) {
        const err = '本地认证异常：密钥获取功能已暂停（请确认 WebUI 管理面板在线）'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }
      const helperPath = this.getHelperPath()

      onStatus?.('正在扫描数据库基址...', 0)
      const { stdout: scanOut } = await execFileAsync(helperPath, ['db_scan', pid.toString()])
      const scanRes = JSON.parse(scanOut.trim())

      if (!scanRes.success) {
        const err = scanRes.result || '扫描失败，请确保微信已完全登录'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      const targetAddr = scanRes.target_addr
      kf(`scan ok pid=${pid} target=${targetAddr}`)
      onStatus?.('已准备就绪，现在可以登录微信了', 0)
      onStatus?.('基址扫描成功，正在执行内存 Hook...', 0)

      const isDocker = process.env.WEFLOW_DOCKER === '1'
      const isRoot = isDocker || (typeof process.getuid === 'function' && process.getuid() === 0)
      const timeoutSec = Math.ceil((timeoutMs + 15_000) / 1000)

      if (isRoot) {
        console.log('[KeyServiceLinux] Running as root/Docker, executing hook directly')
        return await new Promise((resolve) => {
          let settled = false
          let hookChild: any = null
          // Hook 结束（成功/失败/超时/取消）时主动清理 helper 进程，避免其残留在后台
          const cleanupHook = () => {
            try { hookChild?.kill('SIGKILL') } catch { /* ignore */ }
            try { exec(`pkill -f "${helperPath} db_hook"`, () => { /* ignore */ }) } catch { /* ignore */ }
          }
          const finish = (result: DbKeyResult) => {
            if (settled) return
            settled = true
            clearTimeout(watchdog)
            this.activeHookKill = null
            cleanupHook()
            resolve(result)
          }
          // 「取消」时立即结束 helper 并让本次调用返回，避免残留进程
          this.activeHookKill = () => finish({ success: false, error: '已取消' })
          const watchdog = setTimeout(() => {
            execAsync(`kill -CONT ${pid}`).catch(() => {})
            const err = `Hook 等待超时（${Math.round(timeoutMs / 1000)} 秒）`
            kf(`hook timeout pid=${pid} timeout=${timeoutMs}`)
            onStatus?.(err, 2)
            finish({ success: false, error: err })
          }, timeoutMs + 30_000)

          kf(`hook start pid=${pid} timeout=${timeoutMs}`)
          onStatus?.('请在微信中完成一次登录（若已登录请先「退出登录」后重新登录），正在等待密钥回调...', 0)

          // 用 execFile 直接启动 helper（不经 shell），使 hookChild 即为 helper 本体，
          // 这样「取消」时可精确 kill，不会留下孤儿进程。
          hookChild = execFile(
            helperPath,
            ['db_hook', String(pid), String(targetAddr), String(timeoutMs)],
            { timeout: timeoutMs + 30_000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout, stderr) => {
            execAsync(`kill -CONT ${pid}`).catch(() => {})
            if (error) {
              const detail = String(stderr || '').trim()
              const message = detail ? `${error.message}: ${detail}` : error.message
              onStatus?.('Hook 执行失败', 2)
              finish({ success: false, error: `Hook 执行失败: ${message}` })
              return
            }
            try {
              const output = String(stdout || '').trim()
              if (!output) throw new Error('Hook 无输出')
              const hookRes = JSON.parse(output)
              if (hookRes.success) {
                kf(`hook ok pid=${pid} keyLen=${String(hookRes.key || '').length}`)
                onStatus?.('密钥获取成功', 1)
                finish({ success: true, key: hookRes.key })
              } else {
                onStatus?.(hookRes.result, 2)
                finish({ success: false, error: hookRes.result })
              }
            } catch (e: any) {
              onStatus?.('解析 Hook 结果失败', 2)
              finish({ success: false, error: e?.message || '解析 Hook 结果失败' })
            }
          })
        })
      }

      if (!this.sudo || typeof this.sudo.exec !== 'function') {
        const err = 'Linux 授权组件 @vscode/sudo-prompt 未加载，请确认依赖已安装并重新启动 WeFlow'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      return await new Promise((resolve) => {
        let settled = false
        // Hook 结束时尽力清理 helper 进程（Docker/root 下有效）
        const cleanupHook = () => {
          try { exec(`pkill -f "${helperPath} db_hook"`, () => { /* ignore */ }) } catch { /* ignore */ }
        }
        const finish = (result: DbKeyResult) => {
          if (settled) return
          settled = true
          clearTimeout(watchdog)
          this.activeHookKill = null
          cleanupHook()
          resolve(result)
        }
        this.activeHookKill = () => finish({ success: false, error: '已取消' })
        const watchdog = setTimeout(() => {
          execAsync(`kill -CONT ${pid}`).catch(() => {})
          const err = `Hook 等待超时（${Math.round(timeoutMs / 1000)} 秒）。请确认微信登录确认已完成，或重启微信后重试。`
          onStatus?.(err, 2)
          finish({ success: false, error: err })
        }, timeoutMs + 30_000)

        kf(`hook start pid=${pid} timeout=${timeoutMs} (sudo)`)
        onStatus?.('授权通过后请在微信中完成一次登录（若已登录请先「退出登录」后重新登录），正在等待密钥回调...', 0)

        this.sudo.exec(command, options, (error, stdout, stderr) => {
          execAsync(`kill -CONT ${pid}`).catch(() => {})
          if (error) {
            const detail = String(stderr || '').trim()
            const message = detail ? `${error.message}: ${detail}` : error.message
            onStatus?.('授权失败或 Hook 执行失败', 2)
            finish({ success: false, error: `授权失败或 Hook 执行失败: ${message}` })
            return
          }
          try {
            const output = String(stdout || '').trim()
            if (!output) {
              const detail = String(stderr || '').trim()
              throw new Error(detail ? `Hook 无输出: ${detail}` : 'Hook 无输出')
            }
            const hookRes = JSON.parse(output)
            if (hookRes.success) {
              onStatus?.('密钥获取成功', 1)
              finish({ success: true, key: hookRes.key })
            } else {
              onStatus?.(hookRes.result, 2)
              finish({ success: false, error: hookRes.result })
            }
          } catch (e: any) {
            onStatus?.('解析 Hook 结果失败', 2)
            finish({ success: false, error: e?.message || '解析 Hook 结果失败' })
          }
        })
      })
    } catch (err: any) {
      onStatus?.(err.message, 2)
      return { success: false, error: err.message }
    }
  }

  public async autoGetImageKey(
      accountPath?: string,
      onProgress?: (msg: string) => void,
      wxid?: string
  ): Promise<ImageKeyResult> {
    try {
      onProgress?.('正在初始化缓存扫描...');
      const helperPath = this.getHelperPath()
      const { stdout } = await execFileAsync(helperPath, ['image_local'])
      const res = JSON.parse(stdout.trim())
      if (!res.success) return this.autoGetImageKeyByCacheDerivation(accountPath, wxid, onProgress)

      const accounts = res.data.accounts || []
      let account = accounts.find((a: any) => a.wxid === wxid)
      if (!account && accounts.length > 0) account = accounts[0]

      if (account && account.keys && account.keys.length > 0) {
        onProgress?.(`已找到匹配的图片密钥 (wxid: ${account.wxid})`);
        const keyObj = account.keys[0]
        const aesKey = String(keyObj.aesKey || '')
        const verified = await this.verifyImageKeyByTemplate(accountPath, aesKey)
        if (verified === true) {
          onProgress?.('缓存密钥校验成功，已确认可用')
        } else if (verified === false) {
          return { success: false, error: '捕获的密钥未通过本地图片校验（解不开现存 dat，疑似微信登录账号与 WeFlow 配置账号不一致），已拒绝保存' }
        }
        return { success: true, xorKey: keyObj.xorKey, aesKey, verified: verified === true }
      }
      return this.autoGetImageKeyByCacheDerivation(accountPath, wxid, onProgress)
    } catch (err: any) {
      return this.autoGetImageKeyByCacheDerivation(accountPath, wxid, onProgress)
    }
  }

  private async verifyImageKeyByTemplate(accountPath: string | undefined, aesKey: string): Promise<boolean | null> {
    const normalizedPath = String(accountPath || '').trim()
    if (!normalizedPath || !aesKey || aesKey.length < 16 || !existsSync(normalizedPath)) return null
    try {
      const template = await this._findTemplateData(normalizedPath, 32)
      if (!template.ciphertext) return null
      return this.verifyDerivedAesKey(aesKey, template.ciphertext)
    } catch {
      return null
    }
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
    try {
      if (!aesKey || aesKey.length < 16 || ciphertext.length !== 16) return false
      const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii').subarray(0, 16), null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return true
      if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return true
      if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
      if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
      if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
      return false
    } catch {
      return false
    }
  }

  /** wxid 截断到第二个 '_' 之前（如 wxid_abc_123 → wxid_abc），与上游 deriveImageKeys 一致 */
  private cleanWxid(wxid: string): string {
    const first = wxid.indexOf('_')
    if (first === -1) return wxid
    const second = wxid.indexOf('_', first + 1)
    if (second === -1) return wxid
    return wxid.substring(0, second)
  }

  /** 上游图片密钥推导公式：xorKey = code & 0xFF；aesKey = md5(String(code)+cleanWxid)[0:16] */
  private deriveImageKeys(code: number, wxid: string): { xorKey: number; aesKey: string } {
    const cleanedWxid = this.cleanWxid(wxid)
    const xorKey = code & 0xFF
    const aesKey = crypto.createHash('md5').update(code.toString() + cleanedWxid).digest('hex').substring(0, 16)
    return { xorKey, aesKey }
  }

  /** 扫描 kvcomm 目录文件名 key_<N>_*.statistic，收集候选 code（去重） */
  private collectImageKeyCodesLinux(): number[] {
    const home = process.env.HOME || '/root'
    const dirs = [
      join(home, '.xwechat', 'net', 'kvcomm'),
      '/root/.xwechat/net/kvcomm'
    ]
    const codes = new Set<number>()
    for (const dir of dirs) {
      try {
        for (const name of readdirSync(dir)) {
          const m = name.match(/^key_(\d+)_/)
          if (m && name.endsWith('.statistic')) codes.add(parseInt(m[1], 10))
        }
      } catch { /* 目录不存在或不可读，跳过 */ }
    }
    return Array.from(codes)
  }

  /** 收集 wxid 候选：传入值 + 账号目录名 + xwechat_files 下所有 wxid_* 目录 */
  private collectWxidCandidates(accountPath?: string, wxid?: string): string[] {
    const candidates: string[] = []
    const push = (value?: string) => {
      const v = String(value || '').trim()
      if (v.startsWith('wxid_') && !candidates.includes(v)) candidates.push(v)
    }
    push(wxid)
    const normalized = String(accountPath || '').replace(/[\\/]+$/, '')
    if (normalized) {
      push(normalized.split(/[\\/]/).pop())
      const marker = normalized.match(/[\\/]xwechat_files/i)
      if (marker) {
        const root = normalized.slice(0, marker.index! + marker[0].length)
        try {
          for (const entry of readdirSync(root)) {
            if (!entry.startsWith('wxid_')) continue
            try { if (statSync(join(root, entry)).isDirectory()) push(entry) } catch { /* 忽略 */ }
          }
        } catch { /* 忽略 */ }
      }
    }
    return candidates
  }

  /**
   * 图片密钥的纯文件推导管线（上游 6.3.2 路线，作为 helper image_local 失败时的回退）：
   * kvcomm code × wxid 候选 → deriveImageKeys → 用现存 _t.dat 模板做 AES-ECB 魔数校验。
   * 不依赖 helper，也不读进程内存。
   */
  private async autoGetImageKeyByCacheDerivation(
      accountPath?: string,
      wxid?: string,
      onProgress?: (msg: string) => void
  ): Promise<ImageKeyResult> {
    try {
      const codes = this.collectImageKeyCodesLinux()
      if (codes.length === 0) return { success: false, error: '未找到有效的密钥码（kvcomm 缓存为空）' }

      const wxidCandidates = this.collectWxidCandidates(accountPath, wxid)
      const normalizedPath = String(accountPath || '').trim()

      let ciphertext: Buffer | null = null
      if (normalizedPath && existsSync(normalizedPath)) {
        const template = await this._findTemplateData(normalizedPath, 32)
        ciphertext = template.ciphertext
      }

      if (ciphertext) {
        onProgress?.(`缓存推导中（${wxidCandidates.length} 个 wxid × ${codes.length} 个 code）...`)
        for (const candidateWxid of wxidCandidates) {
          for (const code of codes) {
            const { xorKey, aesKey } = this.deriveImageKeys(code, candidateWxid)
            if (!this.verifyDerivedAesKey(aesKey, ciphertext)) continue
            onProgress?.(`缓存推导命中 (wxid: ${candidateWxid}, code: ${code})`)
            return { success: true, xorKey, aesKey, verified: true }
          }
        }
        return { success: false, error: '缓存 code 与当前账号 wxid 未匹配，请确认账号目录后重试，或使用内存扫描' }
      }

      // 无模板密文可验真时，退回首个候选（与上游 fallback 行为一致，标记 verified:false）
      const fallbackWxid = wxidCandidates[0]
      if (!fallbackWxid) return { success: false, error: '未找到账号 wxid 候选，无法推导图片密钥' }
      const { xorKey, aesKey } = this.deriveImageKeys(codes[0], fallbackWxid)
      onProgress?.(`缓存推导回退 (wxid: ${fallbackWxid}, code: ${codes[0]})`)
      return { success: true, xorKey, aesKey, verified: false }
    } catch (err: any) {
      return { success: false, error: `缓存推导失败: ${err.message}` }
    }
  }

  /** 微信 PID 发现：直接扫 /proc/<pid>/exe 精确匹配。
   * 不用 pidof——sysvinit 的 pidof 是 killall5 符号链接，会跳过与调用者同 session 的
   * 进程（wechat 与 weflow 同由 start.sh 拉起、同 session），从 weflow 内永远返回空。 */
  private discoverWechatPids(): number[] {
    const names = new Set(['wechat', 'wechat-bin', 'xwechat'])
    const pids: number[] = []
    try {
      for (const e of readdirSync('/proc')) {
        if (!/^\d+$/.test(e)) continue
        try {
          const exe = readlinkSync(join('/proc', e, 'exe'))
          if (names.has(basename(exe))) pids.push(parseInt(e, 10))
        } catch { /* 权限不足或进程已退出，跳过 */ }
      }
    } catch { /* /proc 不可读 */ }
    return pids.sort((a, b) => a - b)
  }

  public async autoGetImageKeyByMemoryScan(
      accountPath: string,
      onProgress?: (msg: string) => void
  ): Promise<ImageKeyResult> {
    try {
      onProgress?.('正在查找模板文件...')
      let result = await this._findTemplateData(accountPath, 32)
      let { ciphertext, xorKey } = result

      if (ciphertext && xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        result = await this._findTemplateData(accountPath, 100)
        xorKey = result.xorKey
      }

      if (!ciphertext) return { success: false, error: '未找到 V2 模板文件，请先在微信中查看几张图片' }
      if (xorKey === null) return { success: false, error: '未能从模板文件中计算出有效的 XOR 密钥' }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 找微信 PID（/proc/*/exe 扫描，规避 pidof 同 session 盲区）
      const pids = this.discoverWechatPids()
      if (pids.length === 0) return { success: false, error: '微信未运行，无法扫描内存' }
      const pid = pids[0]

      onProgress?.(`已找到微信进程 PID=${pid}，正在提权扫描进程内存...`);

      // 3. 将 Buffer 转换为 hex 传递给 helper
      const ciphertextHex = ciphertext.toString('hex')
      const helperPath = this.getHelperPath()

      try {
        console.log(`[Debug] 准备执行 Helper: ${helperPath} image_mem ${pid} ${ciphertextHex}`);

        const { stdout: memOut, stderr } = await execFileAsync(helperPath, ['image_mem', pid.toString(), ciphertextHex])

        console.log(`[Debug] Helper stdout: ${memOut}`);
        if (stderr) {
          console.warn(`[Debug] Helper stderr: ${stderr}`);
        }

        if (!memOut || memOut.trim() === '') {
          return { success: false, error: 'Helper 返回为空，请检查是否有足够的权限(如需sudo)读取进程内存。' }
        }

        const res = JSON.parse(memOut.trim())

        if (res.success) {
          if (!this.verifyDerivedAesKey(String(res.key || ''), ciphertext!)) {
            return { success: false, error: '内存扫描到的密钥未通过模板校验（解不开模板密文，疑似残留候选或账号不匹配），已拒绝保存' }
          }
          onProgress?.('内存扫描成功，模板校验通过');
          return { success: true, xorKey, aesKey: res.key }
        }
        return { success: false, error: res.result || '未知错误' }

      } catch (err: any) {
        console.error('[Debug] 执行或解析 Helper 时发生崩溃:', err);
        return {
          success: false,
          error: `内存扫描失败: ${err.message}\nstdout: ${err.stdout || '无'}\nstderr: ${err.stderr || '无'}`
        }
      }
    } catch (err: any) {
      return { success: false, error: `内存扫描失败: ${err.message}` }
    }
  }

  private async _findTemplateData(userDir: string, limit: number = 32): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

    // 递归收集 *_t.dat 文件
    const collect = (dir: string, results: string[], maxFiles: number) => {
      if (results.length >= maxFiles) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch { /* 忽略无权限目录 */ }
    }

    const files: string[] = []
    collect(userDir, files, limit)

    // 按修改时间降序
    files.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    })

    let ciphertext: Buffer | null = null
    const tailCounts: Record<string, number> = {}

    for (const f of files.slice(0, 32)) {
      try {
        const data = readFileSync(f)
        if (data.length < 8) continue

        // 统计末尾两字节用于 XOR 密钥
        if (data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 2) {
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        }

        // 提取密文（取第一个有效的）
        if (!ciphertext && data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 0x1F) {
          ciphertext = data.subarray(0xF, 0x1F)
        }
      } catch { /* 忽略 */ }
    }

    // 计算 XOR 密钥
    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) {
        maxCount = count
        const [x, y] = key.split('_').map(Number)
        const k = x ^ 0xFF
        if (k === (y ^ 0xD9)) xorKey = k
      }
    }

    return { ciphertext, xorKey }
  }
}
