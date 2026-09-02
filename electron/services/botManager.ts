import { OneBotServer, OneBotConfig } from './oneBotServer'
import { logger } from './logger'
import { wcdbService } from './wcdbService'
import { chatService } from './chatService'
import * as fs from 'fs'
import { registerImageToken, registerImageTokenWithMeta, registerVideoTokenWithMeta, isThumbnailFilePath, VIDEO_TOKEN_TTL_MS } from './httpService'

const GROUP_TTL_MS = 5 * 60 * 1000
const PRIVATE_TTL_MS = 10 * 60 * 1000

interface GroupInfo {
  wxid: string
  numericId: number
  groupName: string
  myNickname: string
  myWxid: string
  memberCount: number
  updatedAt: number
}

interface PrivateInfo {
  wxid: string
  numericId: number
  remark: string
  nickName: string
  alias: string
  updatedAt: number
}

const groupByWxid = new Map<string, GroupInfo>()
const groupByNumeric = new Map<number, GroupInfo>()
const groupByName = new Map<string, string>()
const privateByWxid = new Map<string, PrivateInfo>()
const privateByNumeric = new Map<number, PrivateInfo>()
const privateByName = new Map<string, string>()

export function numericIdOf(wxid: string): number {
  let hash = 5381
  for (let i = 0; i < wxid.length; i++) {
    hash = ((hash << 5) + hash) + wxid.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export function wxidToNumeric(wxid: string): number {
  return numericIdOf(wxid)
}

export async function preloadIdentity(myWxid: string): Promise<void> {
  try {
    const result = await wcdbService.getContactsCompact()
    if (!result.success || !Array.isArray(result.contacts)) {
      logger.warn('onebot', `preloadIdentity: getContactsCompact failed: ${result.error}`)
      return
    }
    const contacts = result.contacts as Array<Record<string, any>>
    let groupCount = 0
    let privateCount = 0
    for (const row of contacts) {
      const username = String(row.username || row.user_name || row.userName || '').trim()
      if (!username) continue
      const remark = String(row.remark || row.Remark || '').trim()
      const nickName = String(row.nickName || row.nick_name || row.nickname || row.NickName || '').trim()
      const alias = String(row.alias || row.Alias || '').trim()
      const displayName = remark || nickName || alias || username
      if (username.endsWith('@chatroom')) {
        const info: GroupInfo = {
          wxid: username,
          numericId: numericIdOf(username),
          groupName: displayName,
          myNickname: '',
          myWxid: myWxid,
          memberCount: 0,
          updatedAt: Date.now()
        }
        groupByWxid.set(username, info)
        groupByNumeric.set(info.numericId, info)
        if (displayName !== username) {
          groupByName.set(displayName, username)
        }
        groupCount++
      } else if (username.startsWith('wxid_')) {
        const info: PrivateInfo = {
          wxid: username,
          numericId: numericIdOf(username),
          remark,
          nickName,
          alias,
          updatedAt: Date.now()
        }
        privateByWxid.set(username, info)
        privateByNumeric.set(info.numericId, info)
        if (remark) privateByName.set(remark, username)
        if (nickName) privateByName.set(nickName, username)
        privateCount++
      }
    }
    logger.info('onebot', `preloadIdentity: loaded ${groupCount} groups, ${privateCount} contacts`)
  } catch (e: any) {
    logger.warn('onebot', `preloadIdentity error: ${e?.message || e}`)
  }
}

export function cacheGroup(sessionId: string, groupName: string, myWxid: string): GroupInfo | undefined {
  const now = Date.now()
  let info = groupByWxid.get(sessionId)
  if (!info) {
    info = {
      wxid: sessionId,
      numericId: numericIdOf(sessionId),
      groupName,
      myNickname: '',
      myWxid,
      memberCount: 0,
      updatedAt: now
    }
    groupByWxid.set(sessionId, info)
    groupByNumeric.set(info.numericId, info)
  }
  if (groupName && groupName !== sessionId) {
    info.groupName = groupName
    groupByName.set(groupName, sessionId)
  }
  info.updatedAt = now
  return info
}

export function cachePrivate(senderWxid: string): PrivateInfo | undefined {
  const now = Date.now()
  let info = privateByWxid.get(senderWxid)
  if (!info) {
    info = {
      wxid: senderWxid,
      numericId: numericIdOf(senderWxid),
      remark: '',
      nickName: '',
      alias: '',
      updatedAt: now
    }
    privateByWxid.set(senderWxid, info)
    privateByNumeric.set(info.numericId, info)
  }
  return info
}

export function resolveGroupSearchName(numericId: number | string): string | undefined {
  const id = typeof numericId === 'string' ? parseInt(numericId, 10) : numericId
  if (!Number.isFinite(id)) return undefined
  const info = groupByNumeric.get(id)
  if (info?.groupName && info.groupName !== info.wxid) {
    return info.groupName
  }
  return undefined
}

export function resolvePrivateSearchName(numericId: number | string): string | undefined {
  const infoByWxid = privateByWxid.get(String(numericId))
  if (infoByWxid) {
    return infoByWxid.alias || infoByWxid.remark || infoByWxid.nickName || infoByWxid.wxid
  }
  const id = typeof numericId === 'string' ? parseInt(numericId, 10) : numericId
  if (!Number.isFinite(id)) return undefined
  const info = privateByNumeric.get(id)
  if (info) {
    return info.alias || info.remark || info.nickName || info.wxid
  }
  return undefined
}

export function getGroup(wxid: string): GroupInfo | undefined {
  return groupByWxid.get(wxid)
}

export function getPrivateNameByNumeric(numericId: number): string | undefined {
  const info = privateByNumeric.get(numericId)
  if (!info) return undefined
  return info.remark || info.nickName || info.alias || info.wxid
}

export function getPrivateByNumeric(numericId: number): PrivateInfo | undefined {
  return privateByNumeric.get(numericId)
}

export function getGroupByNumeric(numericId: number): GroupInfo | undefined {
  return groupByNumeric.get(numericId)
}

/**
 * 统一数字 → wxid/显示名 反向解析（双通道共享身份层的一部分）。
 * 同时检查群与私聊映射，返回权威 wxid 与显示名；未命中时返回 undefined。
 */
export function resolveIdentityByNumeric(numericId: number | string): { wxid?: string; displayName?: string; isGroup?: boolean } | undefined {
  const id = typeof numericId === 'string' ? parseInt(numericId, 10) : numericId
  if (!Number.isFinite(id)) return undefined

  const group = groupByNumeric.get(id)
  if (group) {
    return {
      wxid: group.wxid,
      displayName: group.groupName && group.groupName !== group.wxid ? group.groupName : group.wxid,
      isGroup: true
    }
  }

  const priv = privateByNumeric.get(id)
  if (priv) {
    return {
      wxid: priv.wxid,
      displayName: priv.remark || priv.nickName || priv.alias || priv.wxid,
      isGroup: false
    }
  }

  return undefined
}

export function scheduleGroupRefresh(wxid: string): void {
  const info = groupByWxid.get(wxid)
  if (!info) return
  const now = Date.now()
  if (now - info.updatedAt < GROUP_TTL_MS) return
  info.updatedAt = now
  void (async () => {
    try {
      const contact = await chatService.getContact(wxid)
      if (contact) {
        const displayName = contact.remark || contact.nickName || contact.alias || wxid
        info.groupName = displayName
        groupByName.set(displayName, wxid)
      }
    } catch {}
  })()
}

export function schedulePrivateRefresh(wxid: string): void {
  const info = privateByWxid.get(wxid)
  if (!info) return
  const now = Date.now()
  if (now - info.updatedAt < PRIVATE_TTL_MS) return
  info.updatedAt = now
  void (async () => {
    try {
      const contact = await chatService.getContact(wxid)
      if (contact) {
        info.remark = contact.remark || ''
        info.nickName = contact.nickName || ''
        info.alias = contact.alias || ''
        if (info.remark) privateByName.set(info.remark, wxid)
        if (info.nickName) privateByName.set(info.nickName, wxid)
      }
    } catch {}
  })()
}

interface BotEntry {
  id: string
  name: string
  mode: 'http' | 'ws'
  direction: 'server' | 'client'
  address: string
  port: number
  token: string
  enabled: boolean
  server: OneBotServer | null
  status: 'running' | 'stopped' | 'error'
  error?: string
  lastHealthCheck?: number
  clientCount?: number
  connectionStatus?: 'connected' | 'disconnected' | 'unknown'
}

interface BotConfig {
  id: string
  name: string
  mode: 'http' | 'ws'
  direction: 'server' | 'client'
  address: string
  port: number
  token: string
  enabled: boolean
}

const bots: Map<string, BotEntry> = new Map()
let onMessageCallback: ((msg: any) => void) | null = null
let currentSelfWxid = ''
let getConfigRef: ((key: string) => any) | null = null

export function setBotMessageCallback(cb: (msg: any) => void) {
  onMessageCallback = cb
}

const groupNameCache: Map<string, string> = new Map()
const groupSelfNameCache: Map<string, string> = new Map()

export function getCachedGroupName(chatroomId: string): string | undefined {
  return groupNameCache.get(chatroomId)
}

export function getCachedSelfName(chatroomId: string): string | undefined {
  return groupSelfNameCache.get(chatroomId)
}

function parseBotsConfig(raw: string | BotConfig[]): BotConfig[] {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function startBotManager(
  botsConfigRaw: string | BotConfig[],
  getConfig: (key: string) => any,
  selfDisplayName: string,
  selfWxid?: string
): Promise<void> {
  currentSelfWxid = selfWxid || currentSelfWxid
  getConfigRef = getConfig
  const configs = parseBotsConfig(botsConfigRaw)
  log(`BotManager: Found ${configs.length} bot configs`)

  for (const cfg of configs) {
    if (!cfg.enabled) {
      log(`BotManager: Skipping disabled bot "${cfg.name}" (${cfg.id})`)
      bots.set(cfg.id, {
        ...cfg,
        server: null,
        status: 'stopped'
      })
      continue
    }

    if (bots.has(cfg.id) && bots.get(cfg.id)!.status === 'running') {
      log(`BotManager: Bot "${cfg.name}" already running, skipping`)
      continue
    }

    await startBot(cfg, getConfig)
  }

  setInterval(() => { healthCheckAll() }, 30_000)
}

async function startBot(cfg: BotConfig, getConfig: (key: string) => any): Promise<void> {
  log(`BotManager: Starting bot "${cfg.name}" on port ${cfg.port} (${cfg.mode}/${cfg.direction})...`)

  const entry: BotEntry = {
    ...cfg,
    server: null,
    status: 'stopped'
  }

  if (cfg.mode === 'http' || (cfg.mode === 'ws' && cfg.direction === 'server')) {
    const serverConfig: OneBotConfig = {
      enabled: true,
      port: cfg.port,
      accessToken: cfg.token || '',
      selfId: currentSelfWxid ? String(wxidToNumeric(currentSelfWxid)) : (cfg.name || cfg.id),
      maxConnections: 10,
      broadcastBatchSize: 100,
      broadcastIntervalMs: 50
    }

    const server = new OneBotServer(serverConfig)

    server.on('started', () => {
      log(`BotManager: Bot "${cfg.name}" started on port ${cfg.port}`)
      entry.status = 'running'
    })

    server.on('error', (err: any) => {
      log(`BotManager: Bot "${cfg.name}" error: ${err}`)
      entry.status = 'error'
      entry.error = String(err)
    })

    server.on('api:send_private_msg', (data: any) => {
      log(`BotManager: Bot "${cfg.name}" send_private_msg: ${JSON.stringify(data).substring(0, 100)}`)
      if (onMessageCallback) {
        onMessageCallback({
          action: 'send_private_msg',
          botId: cfg.id,
          botName: cfg.name,
          params: data
        })
      }
    })

    server.on('api:send_group_msg', (data: any) => {
      log(`BotManager: Bot "${cfg.name}" send_group_msg: ${JSON.stringify(data).substring(0, 100)}`)
      if (onMessageCallback) {
        onMessageCallback({
          action: 'send_group_msg',
          botId: cfg.id,
          botName: cfg.name,
          params: data
        })
      }
    })

    server.on('api:send_msg', (data: any) => {
      log(`BotManager: Bot "${cfg.name}" send_msg: ${JSON.stringify(data).substring(0, 100)}`)
      if (onMessageCallback) {
        onMessageCallback({
          action: 'send_msg',
          botId: cfg.id,
          botName: cfg.name,
          params: data
        })
      }
    })

    try {
      await server.start()
      entry.server = server
      entry.status = 'running'
    } catch (err: any) {
      log(`BotManager: Bot "${cfg.name}" failed to start: ${err}`)
      entry.status = 'error'
      entry.error = String(err)
    }
  } else if (cfg.mode === 'ws' && cfg.direction === 'client') {
    // WS Client 模式：WeFlow 作为客户端连接到外部 WS Server（如 AstrBot）
    const wsUrl = cfg.address.startsWith('ws') ? cfg.address
      : `ws://${cfg.address}:${cfg.port}`
    const wsPath = wsUrl.includes('/ws') ? wsUrl : `${wsUrl}/ws`

    const { OneBotWsClient } = require('./oneBotWsClient')
    const client = new OneBotWsClient({
      id: cfg.id,
      name: cfg.name,
      url: wsPath,
      token: cfg.token || '',
      selfId: currentSelfWxid ? String(wxidToNumeric(currentSelfWxid)) : (cfg.name || cfg.id),
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 20
    })

    client.on('connected', () => {
      log(`BotManager: Bot "${cfg.name}" connected to ${wsPath}`)
      entry.status = 'running'
      entry.error = undefined
    })

    client.on('disconnected', () => {
      log(`BotManager: Bot "${cfg.name}" disconnected from ${wsPath}`)
      entry.status = 'stopped'
    })

    client.on('failed', () => {
      log(`BotManager: Bot "${cfg.name}" connection failed permanently`)
      entry.status = 'error'
      entry.error = 'Max reconnect attempts reached'
    })

    client.on('api', async (request: { action: string; params?: any; echo?: any }) => {
      log(`BotManager: Bot "${cfg.name}" received API: ${request.action}`)
      // 外部 server 发来的 API 请求 → 转发到 onMessageCallback
      // echo 缺失时生成 requestId，供发送完成回填真实 messageId/ack（SendAck 回执透传）
      const echo = request.echo ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      if (onMessageCallback) {
        onMessageCallback({
          action: request.action,
          botId: cfg.id,
          botName: cfg.name,
          params: request.params || {},
          echo
        })
      }
      // 返回响应（send 系列等待异步发送完成，回传真实 messageId/ack）
      try {
        const result = await handleApiAction(request.action, request.params || {}, cfg.id, echo)
        client.sendResponse({
          retcode: 0,
          status: 'ok',
          data: result,
          echo: request.echo
        })
      } catch (e: any) {
        client.sendResponse({
          retcode: 100,
          status: 'failed',
          data: null,
          message: e.message || String(e),
          echo: request.echo
        })
      }
    })

    entry.server = client as any
    try {
      await client.connect()
      entry.status = 'running'
      log(`BotManager: Bot "${cfg.name}" WS client connecting to ${wsPath}`)
    } catch (err: any) {
      log(`BotManager: Bot "${cfg.name}" WS client connect failed: ${err}`)
      entry.status = 'error'
      entry.error = String(err)
    }
  }

  bots.set(cfg.id, entry)
}

export async function stopBot(botId: string): Promise<boolean> {
  const entry = bots.get(botId)
  if (!entry) return false

  if (entry.server) {
    try {
      // WS Client 有 disconnect()，Server 有 stop()
      if (typeof (entry.server as any).disconnect === 'function') {
        (entry.server as any).disconnect()
      } else if (typeof (entry.server as any).stop === 'function') {
        await (entry.server as any).stop()
      }
    } catch {}
    entry.server = null
  }
  entry.status = 'stopped'
  entry.error = undefined
  log(`BotManager: Bot "${entry.name}" stopped`)
  return true
}

export async function stopAllBots(): Promise<void> {
  for (const [id] of bots) {
    await stopBot(id)
  }
}

export async function restartBot(botId: string, getConfig: (key: string) => any): Promise<boolean> {
  await stopBot(botId)
  const raw = getConfig('bots')
  const configs = parseBotsConfig(raw)
  const cfg = configs.find((c: BotConfig) => c.id === botId)
  if (!cfg) return false
  await startBot(cfg, getConfig)
  return true
}

export async function healthCheckAll(): Promise<void> {
  const now = Date.now()
  for (const [, entry] of bots) {
    if (entry.status !== 'running') {
      entry.connectionStatus = 'unknown'
      continue
    }

    if (entry.mode === 'http' || (entry.mode === 'ws' && entry.direction === 'server')) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3000)
        const res = await fetch(`http://127.0.0.1:${entry.port}/api/get_status`, {
          signal: controller.signal,
          headers: entry.token ? { Authorization: `Bearer ${entry.token}` } : {},
        })
        clearTimeout(timeout)
        if (res.ok) {
          const body = await res.json() as any
          entry.connectionStatus = 'connected'
          entry.clientCount = body?.data?.client_count ?? entry.server?.getClientCount() ?? 0
        } else {
          entry.connectionStatus = 'disconnected'
        }
      } catch {
        entry.connectionStatus = 'disconnected'
      }
      entry.lastHealthCheck = now
    } else if (entry.mode === 'ws' && entry.direction === 'client') {
      entry.connectionStatus = entry.server?.isConnected() ? 'connected' : 'disconnected'
      entry.lastHealthCheck = now
    }
  }
}

export function getBotStatus(): Array<{
  id: string
  name: string
  mode: string
  direction: string
  port: number
  status: string
  error?: string
  clientCount: number
  connectionStatus?: 'connected' | 'disconnected' | 'unknown'
  lastHealthCheck?: number
}> {
  const result: any[] = []
  for (const [id, entry] of bots) {
    let clientCount = entry.clientCount ?? 0
    if (entry.server) {
      try {
        clientCount = (entry.server as any).clients?.size || clientCount
      } catch {}
    }
    result.push({
      id,
      name: entry.name,
      mode: entry.mode,
      direction: entry.direction,
      port: entry.port,
      status: entry.status,
      error: entry.error,
      clientCount,
      connectionStatus: entry.connectionStatus,
      lastHealthCheck: entry.lastHealthCheck,
    })
  }
  return result
}

/** SendAck 回执透传：send 系列 API 等待异步发送完成（main.ts handler 回填），
 *  超时回退旧行为（假 message_id），避免 OneBot 请求挂死。 */
const SEND_ACK_WAIT_MS = 15000
const sendAckWaiters = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>()

function waitSendAck(botId: string, echo: string): Promise<any> {
  return new Promise((resolve) => {
    const key = `${botId}:${echo}`
    const timer = setTimeout(() => {
      sendAckWaiters.delete(key)
      resolve({ message_id: Date.now() })
    }, SEND_ACK_WAIT_MS)
    sendAckWaiters.set(key, { resolve, timer })
  })
}

/** 发送完成回填（由 main.ts 的 OneBot handler 在 sender.sendMessage 后调用） */
export function resolveSendAck(
  botId: string,
  echo: string | undefined,
  result: { success: boolean; messageId?: string; ack?: string; serverId?: number; error?: string }
): void {
  if (!echo) return
  const key = `${botId}:${echo}`
  const waiter = sendAckWaiters.get(key)
  if (!waiter) return
  clearTimeout(waiter.timer)
  sendAckWaiters.delete(key)
  waiter.resolve({
    message_id: result.messageId || `local_${Date.now()}`,
    ...(result.ack ? { ack: result.ack } : {}),
    ...(result.serverId ? { server_id: result.serverId } : {}),
    ...(result.error ? { error: result.error } : {})
  })
}

async function handleApiAction(action: string, params: any, botId: string, echo: string): Promise<any> {
  switch (action) {
    case 'get_status':
      return { online: true, good: true, client_count: bots.size, self_id: 'WeFlow' }
    case 'get_version_info':
      return { app_name: 'WeFlow-OneBot', app_version: '1.0.0', protocol_version: 'v11' }
    case 'get_login_info':
      return { user_id: 0, nickname: '' }
    case 'get_friend_list':
      return []
    case 'get_group_list':
      return []
    case 'send_private_msg':
    case 'send_group_msg':
    case 'send_msg':
      // 消息发送已在 onMessageCallback（main.ts handler）中处理；等待真实回执
      return await waitSendAck(botId, echo)
    case 'get_msg':
      return { message: null }
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

export function broadcastToAllBots(event: string, data: any, selfWxid?: string, selfDisplayName?: string): void {
  const isGroup = data.sessionType === 'group' || (data.sessionId && data.sessionId.includes('@chatroom'))

  if (isGroup && data.groupName && data.groupName !== data.sessionId) {
    groupNameCache.set(data.sessionId, data.groupName)
  }

  const botDisplayName = selfDisplayName || ''
  if (isGroup && botDisplayName && data.sessionId) {
    groupSelfNameCache.set(data.sessionId, botDisplayName)
  }

  if (data.imageDecryptFailed) {
    logger.warn('onebot', `Image decrypt failed, skipped push: ${data.sessionId}/${data.rawid}`)
    return
  }

  for (const [, entry] of bots) {
    if (entry.server && entry.status === 'running') {
      try {
        const selfId = String(wxidToNumeric(currentSelfWxid || botDisplayName || entry.name || entry.id))
        const effectiveSenderId = isGroup
          ? (data.senderIdAlias || data.senderId || data.senderName)
          : (data.senderId || data.senderIdAlias || data.sessionId)
        const senderUserId = String(wxidToNumeric(effectiveSenderId))
        const originalSenderId = effectiveSenderId
        const senderNickname = data.senderName || data.sourceName || ''
        const senderCard = data.senderCard || senderNickname

        const messageSegments: Array<{ type: string; data: Record<string, string> }> = []

        if (data.imagePath && fs.existsSync(data.imagePath)) {
          const mode = getConfigRef ? (getConfigRef('imageTransferMode') || 'base64') : 'base64'
          const baseUrl = getConfigRef ? (getConfigRef('imageServerBaseUrl') || '') : ''

          if (mode === 'url' && baseUrl) {
            const isThumb = isThumbnailFilePath(data.imagePath)
            const token = registerImageTokenWithMeta(data.imagePath, {
              isThumb,
              sessionId: isThumb ? data.sessionId : undefined,
              imageMd5: isThumb ? data.imageBaseMd5 : undefined,
            })
            const imageUrl = `${baseUrl.replace(/\/+$/, '')}/api/image?token=${token}`
            messageSegments.push({ type: 'image', data: { file: imageUrl } })
          } else {
            const buf = fs.readFileSync(data.imagePath)
            const b64 = buf.toString('base64')
            messageSegments.push({ type: 'image', data: { file: `base64://${b64}` } })
          }
        } else if (data.imagePath) {
          messageSegments.push({ type: 'image', data: { file: `file://${data.imagePath}` } })
        } else if (data.emojiUrl) {
          messageSegments.push({ type: 'image', data: { file: data.emojiUrl } })
        }

        // 入站视频段（ADAPTER-MEDIA-CONTRACT §3）：视频无 base64 可行形态，
        // 配置了 imageServerBaseUrl 即发 video 段（不再跟随图片传输模式）；
        // 未配置 baseUrl 才退化为仅元数据。
        if (data.videoPath && fs.existsSync(data.videoPath)) {
          const baseUrl = getConfigRef ? (getConfigRef('imageServerBaseUrl') || '') : ''
          if (baseUrl) {
            const videoToken = registerVideoTokenWithMeta(data.videoPath)
            const videoUrl = `${baseUrl.replace(/\/+$/, '')}/api/media?token=${videoToken}`
            // astrbot Video 组件自带 cover 字段（components.py:288），封面直接挂段内
            const videoData: Record<string, string> = { file: videoUrl }
            if (data.videoPosterPath && fs.existsSync(data.videoPosterPath)) {
              // cover 与视频本体同寿命（1h），避免图片级 2min TTL 先过期导致封面 404
              data.videoPosterUrl = `${baseUrl.replace(/\/+$/, '')}/api/image?token=${registerImageTokenWithMeta(data.videoPosterPath, { isThumb: false, ttlMs: VIDEO_TOKEN_TTL_MS })}`
              videoData.cover = data.videoPosterUrl
            }
            messageSegments.push({ type: 'video', data: videoData })
          } else if (data.videoPosterPath && fs.existsSync(data.videoPosterPath)) {
            // 无对外地址：视频本体无处可链，仅元数据；封面落 file://（同机场景）
            data.videoPosterUrl = `file://${data.videoPosterPath}`
          }
        } else if (data.videoPosterPath && fs.existsSync(data.videoPosterPath)) {
          // 视频本体缺失（群视频懒下载）：降级推封面，标注是视频便于模型辨别。
          // 配置了对外地址就走 URL（file:// 跨容器不可达），无 baseUrl 才回退 file://
          const baseUrl = getConfigRef ? (getConfigRef('imageServerBaseUrl') || '') : ''
          if (baseUrl) {
            const posterToken = registerImageTokenWithMeta(data.videoPosterPath, { isThumb: false, ttlMs: VIDEO_TOKEN_TTL_MS })
            messageSegments.push({ type: 'image', data: { file: `${baseUrl.replace(/\/+$/, '')}/api/image?token=${posterToken}` } })
          } else {
            messageSegments.push({ type: 'image', data: { file: `file://${data.videoPosterPath}` } })
          }
          messageSegments.push({ type: 'text', data: { text: '（以上为视频封面截图，视频文件未下载）' } })
        }

        if (isGroup && data.content) {
          const escapedDisplay = botDisplayName ? botDisplayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
          const escapedWxid = selfWxid ? selfWxid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
          const atParts = [escapedDisplay, escapedWxid].filter(Boolean)
          const atPattern = atParts.length > 0 ? new RegExp(`@(?:${atParts.join('|')})`, 'i') : null
          const match = atPattern ? data.content.match(atPattern) : null

          if (match) {
            const beforeAt = data.content.substring(0, match.index)
            const afterAt = data.content.substring(match.index + match[0].length)
            if (beforeAt) messageSegments.push({ type: 'text', data: { text: beforeAt } })
            messageSegments.push({ type: 'at', data: { qq: selfId } })
            if (afterAt) messageSegments.push({ type: 'text', data: { text: afterAt } })
          } else {
            messageSegments.push({ type: 'text', data: { text: data.content || '' } })
          }
        } else if (!data.imagePath && !data.emojiUrl) {
          messageSegments.push({ type: 'text', data: { text: data.content || '' } })
        }

        const baseMsg: any = {
          time: Math.floor(Date.now() / 1000),
          self_id: selfId,
          post_type: 'message',
          message_type: isGroup ? 'group' : 'private',
          sub_type: isGroup ? 'normal' : 'friend',
          message_id: Date.now(),
          // 跨通道相关键：与插件 HTTP 通道共享，AstrBot 可据此对同一消息去重/对齐
          rawid: data.rawid != null ? String(data.rawid) : undefined,
          user_id: senderUserId,
          message: messageSegments,
          raw_message: data.content || '',
          // 头像 CDN 链接（wx.qlogo.cn），供 OneBot 消费方取用
          avatar: data.avatarUrl ? String(data.avatarUrl) : undefined,
          sender: {
            user_id: senderUserId,
            nickname: senderNickname,
            card: senderCard,
            role: 'member',
            sex: 'unknown',
            age: 0
          }
        }
        if (isGroup) {
          baseMsg.group_id = String(wxidToNumeric(data.sessionId))
          baseMsg.group_name = data.groupName || data.sessionId
        }
        entry.server.pushMessage(baseMsg)
      } catch {}
    }
  }
}

function log(msg: string) {
  logger.info('onebot', msg)
}
