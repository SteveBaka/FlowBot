import { OneBotServer, OneBotConfig } from './oneBotServer'

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

export function setBotMessageCallback(cb: (msg: any) => void) {
  onMessageCallback = cb
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
  getConfig: (key: string) => any
): Promise<void> {
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
      selfId: cfg.name || cfg.id,
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
    log(`BotManager: WS client mode not yet implemented for "${cfg.name}"`)
    entry.status = 'stopped'
    entry.error = 'WS client mode not yet implemented'
  }

  bots.set(cfg.id, entry)
}

export async function stopBot(botId: string): Promise<boolean> {
  const entry = bots.get(botId)
  if (!entry) return false

  if (entry.server) {
    try {
      await entry.server.stop()
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

export function getBotStatus(): Array<{
  id: string
  name: string
  mode: string
  direction: string
  port: number
  status: string
  error?: string
  clientCount: number
}> {
  const result: any[] = []
  for (const [id, entry] of bots) {
    let clientCount = 0
    if (entry.server) {
      try {
        clientCount = (entry.server as any).clients?.size || 0
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
      clientCount
    })
  }
  return result
}

export function broadcastToAllBots(event: string, data: any): void {
  for (const [, entry] of bots) {
    if (entry.server && entry.status === 'running') {
      try {
        entry.server.pushMessage(data)
      } catch {}
    }
  }
}

function log(msg: string) {
  console.log(`[BotManager] ${msg}`)
}
