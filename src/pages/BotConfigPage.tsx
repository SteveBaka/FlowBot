import { useEffect, useState } from 'react'
import { Bot, Power, Globe, Key, Server, Activity, Zap, Clock, Save, RefreshCw } from 'lucide-react'
import * as configService from '../services/config'
import './BotConfigPage.scss'

interface OneBotConfig {
  enabled: boolean
  port: number
  accessToken: string
  selfId: string
  maxConnections: number
  broadcastBatchSize: number
  broadcastIntervalMs: number
  debounceMs: number
  batchSize: number
}

function BotConfigPage() {
  const [config, setConfig] = useState<OneBotConfig>({
    enabled: false,
    port: 3001,
    accessToken: '',
    selfId: '',
    maxConnections: 10,
    broadcastBatchSize: 100,
    broadcastIntervalMs: 50,
    debounceMs: 350,
    batchSize: 50,
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [activeTab, setActiveTab] = useState<'basic' | 'performance'>('basic')

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    const [enabled, port, accessToken, selfId, maxConnections, broadcastBatchSize, broadcastIntervalMs, debounceMs, batchSize] = await Promise.all([
      configService.getOneBotEnabled(),
      configService.getOneBotPort(),
      configService.getOneBotAccessToken(),
      configService.getOneBotSelfId(),
      configService.getOneBotMaxConnections(),
      configService.getOneBotBroadcastBatchSize(),
      configService.getOneBotBroadcastIntervalMs(),
      configService.getOneBotDebounceMs(),
      configService.getOneBotBatchSize(),
    ])

    setConfig({
      enabled,
      port,
      accessToken,
      selfId,
      maxConnections,
      broadcastBatchSize,
      broadcastIntervalMs,
      debounceMs,
      batchSize,
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage('')
    try {
      await Promise.all([
        configService.setOneBotEnabled(config.enabled),
        configService.setOneBotPort(config.port),
        configService.setOneBotAccessToken(config.accessToken),
        configService.setOneBotSelfId(config.selfId),
        configService.setOneBotMaxConnections(config.maxConnections),
        configService.setOneBotBroadcastBatchSize(config.broadcastBatchSize),
        configService.setOneBotBroadcastIntervalMs(config.broadcastIntervalMs),
        configService.setOneBotDebounceMs(config.debounceMs),
        configService.setOneBotBatchSize(config.batchSize),
      ])
      setMessage('配置已保存')
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      setMessage('保存失败: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bot-config-page">
      <div className="bot-config-header">
        <div className="bot-config-title">
          <Bot size={24} />
          <h2>Bot 配置</h2>
        </div>
        <div className="bot-config-actions">
          <button className="btn btn-secondary" onClick={loadConfig} disabled={saving}>
            <RefreshCw size={16} />
            刷新
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <Save size={16} />
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {message && (
        <div className={`bot-config-message ${message.includes('失败') ? 'error' : 'success'}`}>
          {message}
        </div>
      )}

      <div className="bot-config-tabs">
        <button
          className={`tab-btn ${activeTab === 'basic' ? 'active' : ''}`}
          onClick={() => setActiveTab('basic')}
        >
          <Globe size={16} />
          基础设置
        </button>
        <button
          className={`tab-btn ${activeTab === 'performance' ? 'active' : ''}`}
          onClick={() => setActiveTab('performance')}
        >
          <Zap size={16} />
          性能配置
        </button>
      </div>

      <div className="bot-config-content">
        {activeTab === 'basic' && (
          <div className="config-section">
            <div className="config-item">
              <div className="config-label">
                <Power size={16} />
                <span>启用 OneBot 服务</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div className="config-item">
              <div className="config-label">
                <Globe size={16} />
                <span>HTTP API 端口</span>
              </div>
              <input
                type="number"
                className="config-input"
                value={config.port}
                onChange={(e) => setConfig({ ...config, port: Number(e.target.value) || 3001 })}
                min={1}
                max={65535}
              />
            </div>

            <div className="config-item">
              <div className="config-label">
                <Key size={16} />
                <span>Access Token</span>
              </div>
              <input
                type="text"
                className="config-input"
                value={config.accessToken}
                onChange={(e) => setConfig({ ...config, accessToken: e.target.value })}
                placeholder="留空表示不验证"
              />
            </div>

            <div className="config-item">
              <div className="config-label">
                <Server size={16} />
                <span>Self ID</span>
              </div>
              <input
                type="text"
                className="config-input"
                value={config.selfId}
                onChange={(e) => setConfig({ ...config, selfId: e.target.value })}
                placeholder="机器人 ID"
              />
            </div>

            <div className="config-item">
              <div className="config-label">
                <Activity size={16} />
                <span>最大连接数</span>
              </div>
              <input
                type="number"
                className="config-input"
                value={config.maxConnections}
                onChange={(e) => setConfig({ ...config, maxConnections: Number(e.target.value) || 10 })}
                min={1}
                max={100}
              />
            </div>
          </div>
        )}

        {activeTab === 'performance' && (
          <div className="config-section">
            <div className="config-item">
              <div className="config-label">
                <Zap size={16} />
                <span>广播批处理大小</span>
              </div>
              <input
                type="number"
                className="config-input"
                value={config.broadcastBatchSize}
                onChange={(e) => setConfig({ ...config, broadcastBatchSize: Number(e.target.value) || 100 })}
                min={1}
                max={1000}
              />
            </div>

            <div className="config-item">
              <div className="config-label">
                <Clock size={16} />
                <span>广播间隔 (ms)</span>
              </div>
              <input
                type="number"
                className="config-input"
                value={config.broadcastIntervalMs}
                onChange={(e) => setConfig({ ...config, broadcastIntervalMs: Number(e.target.value) || 50 })}
                min={10}
                max={5000}
              />
            </div>

            <div className="config-item">
              <div className="config-label">
                <Clock size={16} />
                <span>去抖延迟 (ms)</span>
              </div>
              <input
                type="number"
                className="config-input"
                value={config.debounceMs}
                onChange={(e) => setConfig({ ...config, debounceMs: Number(e.target.value) || 350 })}
                min={50}
                max={2000}
              />
            </div>

            <div className="config-item">
              <div className="config-label">
                <Zap size={16} />
                <span>消息批处理大小</span>
              </div>
              <input
                type="number"
                className="config-input"
                value={config.batchSize}
                onChange={(e) => setConfig({ ...config, batchSize: Number(e.target.value) || 50 })}
                min={1}
                max={500}
              />
            </div>
          </div>
        )}
      </div>

      <div className="bot-config-info">
        <h4>状态信息</h4>
        <div className="status-grid">
          <div className="status-item">
            <span className="status-label">服务状态</span>
            <span className={`status-value ${config.enabled ? 'online' : 'offline'}`}>
              {config.enabled ? '已启用' : '未启用'}
            </span>
          </div>
          <div className="status-item">
            <span className="status-label">API 端口</span>
            <span className="status-value">{config.port}</span>
          </div>
          <div className="status-item">
            <span className="status-label">连接限制</span>
            <span className="status-value">{config.maxConnections}</span>
          </div>
          <div className="status-item">
            <span className="status-label">Self ID</span>
            <span className="status-value">{config.selfId || '(未设置)'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default BotConfigPage
