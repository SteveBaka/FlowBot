import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Key, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff,
  Database, Wand2, ShieldCheck, FolderSearch
} from 'lucide-react'
import * as configService from '../services/config'
import './AccountManagementPage.scss'

export default function AddAccountPage() {
  const navigate = useNavigate()

  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [imageXorKey, setImageXorKey] = useState(0)
  const [imageAesKey, setImageAesKey] = useState('')

  const [wxidOptions, setWxidOptions] = useState<Array<{ wxid: string; modifiedTime: number; nickname?: string }>>([])

  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isManualStartPrompt, setIsManualStartPrompt] = useState(false)

  const imagePrefetchRef = useRef('')

  const hydrate = useCallback(async () => {
    const [savedDbPath, savedWxid] = await Promise.all([
      configService.getDbPath(),
      configService.getMyWxid()
    ])
    if (savedDbPath) setDbPath(savedDbPath)
    if (savedWxid) setWxid(savedWxid)
  }, [])

  useEffect(() => { void hydrate() }, [hydrate])

  useEffect(() => {
    const cleanup = window.electronAPI.key.onDbKeyStatus((payload: { message: string; level: number }) => {
      setDbKeyStatus(payload.message)
      if (payload.level === 0) setNotice(null)
      if (payload.level === 1) setNotice({ type: 'success', text: payload.message })
      if (payload.level === 2) setNotice({ type: 'error', text: payload.message })
    })
    return cleanup
  }, [])

  useEffect(() => {
    if (!dbPath || !wxid || decryptKey.length !== 64) return
    const key = `${dbPath}::${wxid}::${decryptKey}`
    if (imagePrefetchRef.current === key) return
    imagePrefetchRef.current = key
    void handleAutoGetImageKey('prefetch-cache', { silentError: true })
  }, [dbPath, wxid, decryptKey])

  const handleAutoDetectPath = useCallback(async () => {
    setIsDetectingPath(true)
    setNotice(null)
    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        setNotice({ type: 'success', text: '已自动检测到数据库目录' })
      } else {
        setNotice({ type: 'error', text: result.error || '未能自动检测到数据库目录' })
      }
    } catch (e) {
      setNotice({ type: 'error', text: `自动检测失败: ${e}` })
    } finally {
      setIsDetectingPath(false)
    }
  }, [])

  const handleScanWxid = useCallback(async () => {
    if (!dbPath) { setNotice({ type: 'error', text: '请先配置数据库目录' }); return }
    if (isScanningWxid) return
    setIsScanningWxid(true)
    setNotice(null)
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      if (wxids.length > 0) {
        const latest = wxids.sort((a, b) => b.modifiedTime - a.modifiedTime)
        setWxid(latest[0].wxid)
        setNotice({ type: 'success', text: `扫描到 ${wxids.length} 个账号` })
      } else {
        setNotice({ type: 'error', text: '未检测到账号目录' })
      }
    } catch (e) {
      setNotice({ type: 'error', text: `扫描失败: ${e}` })
    } finally {
      setIsScanningWxid(false)
    }
  }, [dbPath, isScanningWxid])

  const handleAutoGetDbKey = useCallback(async () => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setIsManualStartPrompt(false)
    setDbKeyStatus('正在连接微信进程...')
    setNotice(null)
    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setDbKeyStatus('密钥获取成功')
        setNotice({ type: 'success', text: '数据库密钥获取成功' })
        await handleScanWxid()
      } else {
        if (
          result.error?.includes('未能自动启动微信') ||
          result.error?.includes('未找到微信进程')
        ) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动微信')
        } else {
          if (result.error?.includes('尚未完成登录')) {
            setDbKeyStatus('请先在微信完成登录后重试')
          } else {
            setDbKeyStatus(result.error || '获取失败')
          }
          setNotice({ type: 'error', text: result.error || '自动获取密钥失败' })
        }
      }
    } catch (e) {
      setDbKeyStatus(`获取失败: ${e}`)
      setNotice({ type: 'error', text: `自动获取密钥失败: ${e}` })
    } finally {
      setIsFetchingDbKey(false)
    }
  }, [dbPath, isFetchingDbKey])

  const handleAutoGetImageKey = useCallback(async (
    source: 'manual-cache' | 'prefetch-cache' = 'manual-cache',
    opts?: { silentError?: boolean }
  ) => {
    if (isFetchingImageKey) return
    if (!dbPath || !wxid) return
    setIsFetchingImageKey(true)
    if (!opts?.silentError) setImageKeyStatus('正在获取图片密钥...')
    try {
      const accountPath = `${dbPath}/${wxid}`
      const result = await window.electronAPI.key.autoGetImageKey(accountPath, wxid)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(result.xorKey)
        setImageAesKey(result.aesKey)
        const status = result.verified ? '图片密钥获取成功（校验通过）' : '已计算图片密钥'
        setImageKeyStatus(status)
        if (!opts?.silentError) setNotice({ type: 'success', text: status })
      } else {
        if (!opts?.silentError) {
          setImageKeyStatus(result.error || '获取失败')
        }
      }
    } catch (e) {
      if (!opts?.silentError) {
        setImageKeyStatus(`获取失败: ${e}`)
      }
    } finally {
      setIsFetchingImageKey(false)
    }
  }, [dbPath, wxid, isFetchingImageKey])

  const handleSave = useCallback(async () => {
    if (!decryptKey || decryptKey.length !== 64) {
      setNotice({ type: 'error', text: '密钥格式不正确，需要 64 位十六进制字符' })
      return
    }
    if (!wxid) {
      setNotice({ type: 'error', text: '未检测到账号，请先扫描账号' })
      return
    }
    setIsSaving(true)
    setNotice(null)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!result?.success) {
        setNotice({ type: 'error', text: result?.error || '数据库连接测试失败' })
        return
      }
      await configService.setDbPath(dbPath)
      await configService.setDecryptKey(decryptKey)
      await configService.setMyWxid(wxid)
      await configService.setWxidConfig(wxid, { decryptKey, imageXorKey, imageAesKey })
      await configService.setOnboardingDone(true)
      setNotice({ type: 'success', text: '账号添加成功' })
      setTimeout(() => navigate('/account-management'), 800)
    } catch (e) {
      setNotice({ type: 'error', text: `保存失败: ${String(e)}` })
    } finally {
      setIsSaving(false)
    }
  }, [dbPath, decryptKey, wxid, imageXorKey, imageAesKey, navigate])

  const canSave = decryptKey.length === 64 && Boolean(wxid) && !isSaving
  const dbKeyReady = decryptKey.length === 64

  return (
    <div className="account-management-page">
      <header className="account-management-header">
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate('/account-management')}
            style={{ marginBottom: 8 }}
          >
            <ArrowLeft size={14} /> 返回账号管理
          </button>
          <h2>添加账号</h2>
          <p>通过自动引导或手动输入配置新的微信账号。</p>
        </div>
      </header>

      <section className="account-add-form">
      {notice && (
        <div className={`account-notice ${notice.type}`}>
          {notice.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          <span>{notice.text}</span>
        </div>
      )}

        {/* Step 1: 数据库目录 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            <Database size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            步骤 1：数据库目录
          </h3>
          <div className="field-group">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="field-input"
                value={dbPath}
                onChange={(e) => setDbPath(e.target.value)}
                placeholder="xwechat_files 目录路径"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleAutoDetectPath()}
                disabled={isDetectingPath}
              >
                {isDetectingPath ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
                {isDetectingPath ? '检测中...' : '自动检测'}
              </button>
            </div>
            <span className="field-hint">点击"自动检测"自动定位 xwechat_files 目录</span>
          </div>
        </div>

        {/* Step 2: 扫描账号 + wxid 选择 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            <FolderSearch size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            步骤 2：扫描并选择账号
          </h3>
          <div className="field-group">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="field-input"
                value={wxid}
                onChange={(e) => setWxid(e.target.value)}
                placeholder="手动输入或扫描获取"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleScanWxid()}
                disabled={isScanningWxid || !dbPath}
              >
                {isScanningWxid ? <Loader2 size={14} className="spin" /> : <FolderSearch size={14} />}
                {isScanningWxid ? '扫描中...' : '扫描账号'}
              </button>
            </div>
            {wxidOptions.length > 1 && (
              <select
                className="field-input"
                value={wxid}
                onChange={(e) => setWxid(e.target.value)}
                style={{ marginTop: 8 }}
              >
                {wxidOptions.map((opt) => (
                  <option key={opt.wxid} value={opt.wxid}>
                    {opt.nickname ? `${opt.nickname} (${opt.wxid})` : opt.wxid}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Step 3: 解密密钥 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            <Key size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            步骤 3：解密密钥
          </h3>
          <div className="field-group">
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <input
                  type={showDecryptKey ? 'text' : 'password'}
                  className="field-input"
                  value={decryptKey}
                  onChange={(e) => setDecryptKey(e.target.value.trim())}
                  placeholder="64 位十六进制密钥"
                  style={{ width: '100%', paddingRight: 36 }}
                />
                <button
                  type="button"
                  onClick={() => setShowDecryptKey(!showDecryptKey)}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}
                >
                  {showDecryptKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { void handleAutoGetDbKey() }}
                disabled={isFetchingDbKey}
              >
                {isFetchingDbKey ? <Loader2 size={14} className="spin" /> : <Key size={14} />}
                {isFetchingDbKey ? '获取中...' : '自动获取'}
              </button>
            </div>
            {dbKeyStatus && (
              <span className="field-hint" style={{ color: dbKeyStatus.includes('成功') ? 'var(--color-success, #22c55e)' : 'var(--text-tertiary)' }}>
                {dbKeyStatus}
              </span>
            )}
            {isManualStartPrompt && (
              <div style={{ marginTop: 8, padding: 12, background: 'var(--bg-tertiary, #333)', borderRadius: 8, fontSize: 13 }}>
                <p style={{ marginBottom: 8 }}>未能自动启动微信，请手动启动微信后点击确认：</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => { setIsManualStartPrompt(false); void handleAutoGetDbKey() }}
                >
                  我已看到登录窗口，继续
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Step 4: 图片密钥 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            <ShieldCheck size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            步骤 4：图片密钥
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 8 }}>（可选）</span>
          </h3>
          <div className="field-group">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="field-input"
                value={imageAesKey}
                readOnly
                placeholder="自动计算或手动输入 AES 密钥"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => { void handleAutoGetImageKey('manual-cache') }}
                disabled={isFetchingImageKey || !dbKeyReady}
              >
                {isFetchingImageKey ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
                {isFetchingImageKey ? '获取中...' : '自动获取'}
              </button>
            </div>
            {imageKeyStatus && (
              <span className="field-hint" style={{ color: imageKeyStatus.includes('成功') || imageKeyStatus.includes('校验通过') ? 'var(--color-success, #22c55e)' : 'var(--text-tertiary)' }}>
                {imageKeyStatus}
              </span>
            )}
          </div>
        </div>

        {/* 保存 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate('/account-management')}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { void handleSave() }}
            disabled={!canSave}
          >
            {isSaving ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
            {isSaving ? '保存中...' : '保存并添加'}
          </button>
        </div>
      </section>
    </div>
  )
}
