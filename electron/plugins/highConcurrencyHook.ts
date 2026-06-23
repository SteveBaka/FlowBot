import { EventEmitter } from 'events'

interface PendingMessage {
  sessionId: string
  timestamp: number
  content: string
  type: number
  senderId: string
  isSend: boolean
  raw?: unknown
}

interface TTLMapEntry {
  value: string
  expiresAt: number
}

class TTLMap {
  private store = new Map<string, TTLMapEntry>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  get(key: string): string | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: string): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key)
    }
  }
}

export class HighConcurrencyHook extends EventEmitter {
  private processing = false
  private rerunRequested = false
  private pendingMessages: PendingMessage[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private batchTimer: ReturnType<typeof setTimeout> | null = null

  private recentMessageKeys: TTLMap
  private seenMessageKeys: TTLMap

  private readonly debounceMs = 350
  private readonly batchSize = 50
  private readonly batchIntervalMs = 100
  private readonly maxQueueSize = 10000
  private readonly messageKeyTtlMs = 10 * 60 * 1000

  constructor() {
    super()
    this.recentMessageKeys = new TTLMap(this.messageKeyTtlMs)
    this.seenMessageKeys = new TTLMap(this.messageKeyTtlMs)
  }

  receiveMessage(msg: PendingMessage): void {
    if (this.pendingMessages.length >= this.maxQueueSize) {
      this.pendingMessages.shift()
    }
    this.pendingMessages.push(msg)
    this.scheduleSync()
  }

  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flushPendingChanges()
    }, this.debounceMs)
  }

  private flushPendingChanges(): void {
    if (this.processing) {
      this.rerunRequested = true
      return
    }

    this.processing = true
    try {
      const batch = this.pendingMessages.splice(0, this.batchSize)
      if (batch.length === 0) return

      const uniqueMessages = batch.filter((msg) => {
        const key = this.buildMessageKey(msg)
        if (this.recentMessageKeys.has(key) || this.seenMessageKeys.has(key)) {
          return false
        }
        this.recentMessageKeys.set(key, key)
        this.seenMessageKeys.set(key, key)
        return true
      })

      if (uniqueMessages.length > 0) {
        this.emit('messages:batch', uniqueMessages)
      }

      if (this.pendingMessages.length > 0) {
        this.scheduleBatch()
      }
    } finally {
      this.processing = false
      if (this.rerunRequested) {
        this.rerunRequested = false
        this.flushPendingChanges()
      }
    }
  }

  private scheduleBatch(): void {
    if (this.batchTimer) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      this.flushPendingChanges()
    }, this.batchIntervalMs)
  }

  private buildMessageKey(msg: PendingMessage): string {
    return `${msg.sessionId}_${msg.timestamp}_${msg.senderId}`
  }

  getStats(): { pending: number; recentKeys: number; seenKeys: number } {
    return {
      pending: this.pendingMessages.length,
      recentKeys: 0,
      seenKeys: 0,
    }
  }

  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.pendingMessages = []
    this.removeAllListeners()
  }
}

let instance: HighConcurrencyHook | null = null

export function getHighConcurrencyHook(): HighConcurrencyHook {
  if (!instance) {
    instance = new HighConcurrencyHook()
  }
  return instance
}
