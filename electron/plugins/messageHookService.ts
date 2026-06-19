/**
 * WeFlow 消息 Hook 服务
 * 通过 DLL Hook 实现微信消息的读取和发送
 * 
 * 发送策略优先级:
 * 1. DLL Hook (如果已安装且可用)
 * 2. 剪贴板方式 (SimpleMessageSender，无需 DLL)
 */
import { EventEmitter } from 'events';
import { join } from 'path';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { getSimpleMessageSender } from './simpleMessageSender';
import {
  WeChatHookPlugin,
  MessageType,
  HookStatus,
  ReadOptions,
  SendOptions,
  SendResult,
  Message,
  HookState,
  PluginMetadata,
  PluginCapabilities,
  PluginEventCallbacks,
} from './plugin-interface';

const execFileAsync = promisify(execFile);

/**
 * 消息 Hook 插件实现
 */
export class MessageHookService extends EventEmitter implements WeChatHookPlugin {
  metadata: PluginMetadata = {
    name: 'wechat-message-hook',
    version: '1.1.0',
    description: 'WeChat message read/write hook plugin (with clipboard fallback for sending)',
    author: 'WeFlow',
    platform: ['win32'],
    minWeChatVersion: '4.0.0',
  };

  capabilities: PluginCapabilities = {
    canReadMessages: true,
    canSendMessage: true,
    canReadContacts: true,
    canReadGroups: true,
    supportedMessageTypes: [
      MessageType.Text,
      MessageType.Image,
      MessageType.Voice,
      MessageType.Video,
      MessageType.Emoji,
      MessageType.Link,
      MessageType.File,
    ],
  };

  private koffi: any = null;
  private lib: any = null;
  private initialized = false;

  // DLL 函数绑定
  private initHook: any = null;
  private sendMessageDll: any = null;
  private pollMessages: any = null;
  private cleanupHook: any = null;
  private getHookStatus: any = null;
  private getMessageCount: any = null;
  private clearMessageBuffer: any = null;
  private freeString: any = null;

  // 状态
  private hookState: HookState = { status: HookStatus.Uninitialized };
  private messagePollTimer: NodeJS.Timeout | null = null;
  private callbacks: PluginEventCallbacks = {};

  constructor() {
    super();
  }

  /**
   * 插件加载
   */
  async onLoad(): Promise<void> {
    console.log('[MessageHookService] Loading plugin...');
    await this.ensureInitialized();
  }

  /**
   * 插件卸载
   */
  async onUnload(): Promise<void> {
    console.log('[MessageHookService] Unloading plugin...');
    await this.stopPolling();
  }

  /**
   * Hook 安装后回调
   */
  async onHookInstalled(): Promise<void> {
    console.log('[MessageHookService] Hook installed, starting message polling...');
    await this.startPolling();
  }

  /**
   * Hook 卸载后回调
   */
  async onHookUninstalled(): Promise<void> {
    console.log('[MessageHookService] Hook uninstalled, stopping message polling...');
    await this.stopPolling();
  }

  /**
   * 初始化 DLL
   */
  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return true;

    if (process.platform !== 'win32') {
      console.error('[MessageHookService] Only supported on Windows');
      return false;
    }

    try {
      this.koffi = require('koffi');
      const dllPath = this.getDllPath();

      if (!existsSync(dllPath)) {
        console.error(`[MessageHookService] DLL not found: ${dllPath}`);
        return false;
      }

      // 本地化网络路径
      const localPath = this.isNetworkPath(dllPath)
        ? this.localizeNetworkDll(dllPath)
        : dllPath;

      this.lib = this.koffi.load(localPath);

      // 绑定 DLL 函数
      this.initHook = this.lib.func('bool InitializeHook(uint32 targetPid)');
      this.sendMessageDll = this.lib.func('bool SendMessageToWeChat(const char* sessionId, const char* content, int32 type, _Out_ void** outResult)');
      this.pollMessages = this.lib.func('bool PollMessages(_Out_ char* buffer, int bufferSize)');
      this.cleanupHook = this.lib.func('bool CleanupHook()');
      this.getHookStatus = this.lib.func('bool GetHookStatus(_Out_ char* buffer, int bufferSize)');
      this.getMessageCount = this.lib.func('int32 GetMessageCount()');
      this.clearMessageBuffer = this.lib.func('void ClearMessageBuffer()');
      this.freeString = this.lib.func('void FreeString(char* ptr)');

      this.initialized = true;
      console.log('[MessageHookService] DLL initialized successfully');
      return true;
    } catch (error) {
      console.error('[MessageHookService] Failed to initialize:', error);
      return false;
    }
  }

  /**
   * 获取 DLL 路径
   */
  private getDllPath(): string {
    const isPackaged = process.env.NODE_ENV === 'production';
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64';
    const candidates: string[] = [];

    if (process.env.MESSAGE_HOOK_DLL_PATH) {
      candidates.push(process.env.MESSAGE_HOOK_DLL_PATH);
    }

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'hooks', 'win32', archDir, 'message_hook.dll'));
      candidates.push(join(process.resourcesPath, 'resources', 'hooks', 'win32', 'x64', 'message_hook.dll'));
    } else {
      const cwd = process.cwd();
      candidates.push(join(cwd, 'resources', 'hooks', 'win32', archDir, 'message_hook.dll'));
      candidates.push(join(cwd, 'resources', 'hooks', 'win32', 'x64', 'message_hook.dll'));
    }

    for (const path of candidates) {
      if (existsSync(path)) return path;
    }

    return candidates[0];
  }

  /**
   * 检查是否为网络路径
   */
  private isNetworkPath(path: string): boolean {
    return path.startsWith('\\\\');
  }

  /**
   * 本地化网络路径
   */
  private localizeNetworkDll(originalPath: string): string {
    try {
      const tempDir = join(os.tmpdir(), 'weflow_dll_cache');
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }
      const localPath = join(tempDir, 'message_hook.dll');
      if (existsSync(localPath)) return localPath;

      copyFileSync(originalPath, localPath);
      return localPath;
    } catch (e) {
      console.error('[MessageHookService] Failed to localize network DLL:', e);
      return originalPath;
    }
  }

  /**
   * 查找 WeChat 进程
   */
  async findWeChatPid(): Promise<number | null> {
    try {
      const script = `
        Get-CimInstance Win32_Process -Filter "Name = 'Weixin.exe'" | 
        Select-Object ProcessId, CommandLine | 
        ConvertTo-Json -Compress
      `;

      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
      if (!stdout || !stdout.trim()) return null;

      let processes = JSON.parse(stdout.trim());
      if (!Array.isArray(processes)) processes = [processes];

      // 选择主进程（命令行最短的那个）
      const target = processes
        .filter((p: any) => p.CommandLine && p.CommandLine.toLowerCase().includes('weixin.exe'))
        .sort((a: any, b: any) => a.CommandLine.length - b.CommandLine.length)[0];

      return target ? target.ProcessId : null;
    } catch (e) {
      console.error('[MessageHookService] Failed to find WeChat process:', e);
      return null;
    }
  }

  /**
   * 安装 Hook
   */
  async installHook(pid: number): Promise<boolean> {
    if (!this.initialized) {
      const success = await this.ensureInitialized();
      if (!success) {
        this.hookState = {
          status: HookStatus.Error,
          error: 'Failed to initialize DLL',
        };
        this.emit('status', this.hookState);
        return false;
      }
    }

    this.hookState = { status: HookStatus.Initializing, pid };
    this.emit('status', this.hookState);

    try {
      const success = this.initHook(pid);
      if (success) {
        this.hookState = {
          status: HookStatus.Installed,
          pid,
          lastActivity: Date.now(),
        };
        this.emit('status', this.hookState);
        console.log(`[MessageHookService] Hook installed successfully (PID: ${pid})`);
        return true;
      } else {
        this.hookState = {
          status: HookStatus.Error,
          pid,
          error: 'DLL returned false',
        };
        this.emit('status', this.hookState);
        return false;
      }
    } catch (error) {
      this.hookState = {
        status: HookStatus.Error,
        pid,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit('status', this.hookState);
      return false;
    }
  }

  /**
   * 卸载 Hook
   */
  async uninstallHook(): Promise<boolean> {
    try {
      if (this.initialized && this.cleanupHook) {
        this.cleanupHook();
      }

      this.hookState = { status: HookStatus.Uninstalled };
      this.emit('status', this.hookState);
      console.log('[MessageHookService] Hook uninstalled');
      return true;
    } catch (error) {
      console.error('[MessageHookService] Failed to uninstall hook:', error);
      return false;
    }
  }

  /**
   * 获取 Hook 状态
   */
  getHookState(): HookState {
    return { ...this.hookState };
  }

  /**
   * 读取消息
   */
  async readMessages(options: ReadOptions): Promise<Message[]> {
    if (this.hookState.status !== HookStatus.Installed) {
      console.warn('[MessageHookService] Hook not installed, cannot read messages');
      return [];
    }

    // 从本地缓存或数据库读取消息
    // 这里可以集成现有的 chatService
    return [];
  }

  /**
   * 发送消息
   * 优先使用 DLL Hook，失败时回退到剪贴板方式
   */
  async sendMessage(options: SendOptions): Promise<SendResult> {
    // 策略1: 如果 DLL Hook 已安装，尝试通过 DLL 发送
    if (this.hookState.status === HookStatus.Installed) {
      try {
        const resultPtr = Buffer.alloc(1024);
        const success = this.sendMessageDll(
          options.sessionId,
          options.content,
          options.type,
          resultPtr
        );

        if (success) {
          const resultStr = resultPtr.toString('utf8').replace(/\0/g, '');
          const result = resultStr ? JSON.parse(resultStr) : {};

          if (resultPtr.readBigUInt64LE(0) !== 0n) {
            try { this.freeString(resultPtr); } catch {}
          }

          return {
            success: true,
            messageId: result.messageId || `local_${Date.now()}`,
            timestamp: result.timestamp || Date.now(),
          };
        }
      } catch (error) {
        console.warn('[MessageHookService] DLL send failed, falling back to clipboard:', error);
      }
    }

    // 策略2: 回退到剪贴板方式 (SimpleMessageSender)
    if (options.type === MessageType.Text && options.content) {
      try {
        const sender = getSimpleMessageSender();
        const result = await sender.sendMessage(options.content);
        if (result.success) {
          return {
            success: true,
            messageId: `clipboard_${Date.now()}`,
            timestamp: Date.now(),
          };
        }
        return {
          success: false,
          error: result.error || 'Clipboard send failed',
          timestamp: Date.now(),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
      }
    }

    return {
      success: false,
      error: this.hookState.status !== HookStatus.Installed
        ? 'Hook not installed and only text messages supported via clipboard fallback'
        : 'Unsupported message type for clipboard fallback',
      timestamp: Date.now(),
    };
  }

  /**
   * 开始消息轮询
   */
  private async startPolling(): Promise<void> {
    if (this.messagePollTimer) return;

    this.messagePollTimer = setInterval(async () => {
      await this.pollNewMessages();
    }, 100); // 100ms 轮询间隔

    console.log('[MessageHookService] Message polling started');
  }

  /**
   * 停止消息轮询
   */
  private async stopPolling(): Promise<void> {
    if (this.messagePollTimer) {
      clearInterval(this.messagePollTimer);
      this.messagePollTimer = null;
      console.log('[MessageHookService] Message polling stopped');
    }
  }

  /**
   * 轮询新消息
   */
  private async pollNewMessages(): Promise<void> {
    if (this.hookState.status !== HookStatus.Installed) return;

    try {
      const buffer = Buffer.alloc(65536); // 64KB buffer
      const hasNewMessages = this.pollMessages(buffer, buffer.length);

      if (hasNewMessages) {
        const dataStr = buffer.toString('utf8').replace(/\0/g, '');
        if (dataStr && dataStr.startsWith('[')) {
          const messages = JSON.parse(dataStr);
          for (const msg of messages) {
            // 转换时间戳 (DLL 返回秒级时间戳)
            const timestampMs = msg.timestamp ? msg.timestamp * 1000 : Date.now();
            
            const message: Message = {
              messageId: msg.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              sessionId: msg.sessionId || '',
              senderId: msg.senderId || '',
              content: msg.content || '',
              type: msg.type || MessageType.Text,
              timestamp: timestampMs,
              isSend: msg.isSend || false,
              status: msg.status,
            };

            this.emit('message', message);
            this.hookState.lastActivity = Date.now();
          }
        }
      }
    } catch (error) {
      console.error('[MessageHookService] Error polling messages:', error);
    }
  }

  /**
   * 清空消息缓冲区
   */
  public clearBuffer(): void {
    if (this.initialized && this.clearMessageBuffer) {
      this.clearMessageBuffer();
    }
  }

  /**
   * 获取缓冲区消息数量
   */
  public getBufferedMessageCount(): number {
    if (this.initialized && this.getMessageCount) {
      return this.getMessageCount();
    }
    return 0;
  }

  /**
   * 注册事件监听
   */
  on(event: 'message', callback: (msg: Message) => void): void;
  on(event: 'status', callback: (status: HookState) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: string, callback: Function): void {
    super.on(event, callback as any);
  }

  /**
   * 取消事件监听
   */
  off(event: string, callback: Function): void {
    super.off(event, callback);
  }
}

/**
 * 单例实例
 */
let instance: MessageHookService | null = null;

export function getMessageHookService(): MessageHookService {
  if (!instance) {
    instance = new MessageHookService();
  }
  return instance;
}
