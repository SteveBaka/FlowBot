import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export type LogCategory = 'weflow' | 'wechat' | 'onebot' | 'vnc' | 'system' | 'sender' | 'keyflow' | 'wcdb'

// 仅落盘、不镜像到 stdout 的类别（保持容器日志干净）：密钥流程
const FILE_ONLY_CATEGORIES: Set<string> = new Set(['keyflow'])

export interface LogEntry {
  time: string
  level: 'info' | 'warn' | 'error' | 'debug'
  category: LogCategory
  message: string
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
const MAX_AGE_DAYS = num(process.env.WEFLOW_LOG_MAX_AGE_DAYS, 7)
const LOG_FILE_MAX_SIZE = num(process.env.WEFLOW_LOG_MAX_BYTES, 10 * 1024 * 1024) // 10MB/文件
const LOG_KEEP_LINES = num(process.env.WEFLOW_LOG_KEEP_LINES, 1000)               // 超限后保留的末尾行数
const LOG_CLEAN_INTERVAL_MS = num(process.env.WEFLOW_LOG_CLEAN_INTERVAL_MS, 10 * 60 * 1000)
// 统一类别清单：清理/统计/清空共用（含 keyflow 与外部写入的 wcdb，避免漏管）
const ALL_LOG_CATEGORIES: LogCategory[] = ['weflow', 'wechat', 'onebot', 'vnc', 'system', 'sender', 'keyflow', 'wcdb']

class Logger {
  private logDir: string
  private streams: Map<string, fs.WriteStream> = new Map()
  private initialized = false
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.logDir = '/opt/weflow/data/logs'
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    try {
      const userData = app.getPath('userData')
      this.logDir = path.join(userData, 'logs')
    } catch {
      this.logDir = '/opt/weflow/data/logs'
    }

    try {
      fs.mkdirSync(this.logDir, { recursive: true })
    } catch {}

    this.cleanupOldLogs()
    this.cleanupOversizedLogs()
    this.startMaintenance()

    console.log(`[Logger] Initialized, log dir: ${this.logDir}`)
  }

  /** 定时维护：周期性按大小/天数清理（不再只在启动时执行一次） */
  private startMaintenance(): void {
    if (this.maintenanceTimer) return
    this.maintenanceTimer = setInterval(() => {
      this.cleanupOldLogs()
      this.cleanupOversizedLogs()
    }, LOG_CLEAN_INTERVAL_MS)
    if (typeof (this.maintenanceTimer as any).unref === 'function') (this.maintenanceTimer as any).unref()
  }

  private getLogFile(category: LogCategory): string {
    return path.join(this.logDir, `${category}.log`)
  }

  private getStream(category: LogCategory): fs.WriteStream {
    if (this.streams.has(category)) return this.streams.get(category)!
    const filePath = this.getLogFile(category)
    const stream = fs.createWriteStream(filePath, { flags: 'a' })
    this.streams.set(category, stream)
    return stream
  }

  log(level: LogEntry['level'], category: LogCategory, message: string): void {
    const now = new Date()
    const time = now.toISOString()
    const line = `[${time}] [${level.toUpperCase()}] [${category}] ${message}\n`

    // Write to category file
    try {
      this.getStream(category).write(line)
    } catch {}

    // Also write to combined log
    try {
      this.getStream('system').write(line)
    } catch {}

    // Console output (short timestamp format for container logs)
    if (FILE_ONLY_CATEGORIES.has(category)) return
    const pad = (n: number) => n.toString().padStart(2, '0')
    const shortTime = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const prefix = `[${shortTime}] [${level.toUpperCase()}] [${category}]`
    if (level === 'error') console.error(prefix, message)
    else if (level === 'warn') console.warn(prefix, message)
    else if (level === 'debug') console.debug(prefix, message)
    else console.log(prefix, message)
  }

  info(category: LogCategory, message: string): void { this.log('info', category, message) }
  warn(category: LogCategory, message: string): void { this.log('warn', category, message) }
  error(category: LogCategory, message: string): void { this.log('error', category, message) }
  debug(category: LogCategory, message: string): void { this.log('debug', category, message) }

  readLogs(options?: { categories?: LogCategory[]; level?: string; search?: string; lines?: number }): string[] {
    const categories = options?.categories || ['weflow', 'wechat', 'onebot', 'vnc', 'system', 'sender', 'keyflow']
    const maxLines = options?.lines || 200
    const levelFilter = options?.level || 'all'
    const searchFilter = options?.search || ''

    const allLines: string[] = []
    for (const cat of categories) {
      const filePath = this.getLogFile(cat)
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8')
          const lines = content.split('\n').filter(Boolean)
          allLines.push(...lines)
        }
      } catch {}
    }

    // Sort by time (newest first)
    allLines.sort((a, b) => {
      const ta = a.substring(1, 25)
      const tb = b.substring(1, 25)
      return tb.localeCompare(ta)
    })

    // Filter by level
    let filtered = allLines
    if (levelFilter && levelFilter !== 'all') {
      const levelStr = `[${levelFilter.toUpperCase()}]`
      filtered = filtered.filter(l => l.includes(levelStr))
    }

    // Filter by search
    if (searchFilter) {
      const search = searchFilter.toLowerCase()
      filtered = filtered.filter(l => l.toLowerCase().includes(search))
    }

    return filtered.slice(0, maxLines)
  }

  getLogStats(): Record<LogCategory, { size: number; lines: number; lastModified: string }> {
    const categories: LogCategory[] = ALL_LOG_CATEGORIES
    const stats: any = {}
    for (const cat of categories) {
      const filePath = this.getLogFile(cat)
      try {
        const stat = fs.statSync(filePath)
        const content = fs.readFileSync(filePath, 'utf-8')
        stats[cat] = {
          size: stat.size,
          lines: content.split('\n').filter(Boolean).length,
          lastModified: stat.mtime.toISOString()
        }
      } catch {
        stats[cat] = { size: 0, lines: 0, lastModified: '' }
      }
    }
    return stats
  }

  clearLogs(category?: LogCategory): void {
    if (category) {
      const filePath = this.getLogFile(category)
      try {
        fs.writeFileSync(filePath, '')
        this.streams.delete(category)
      } catch {}
    } else {
      const categories: LogCategory[] = ALL_LOG_CATEGORIES
      for (const cat of categories) {
        this.clearLogs(cat)
      }
    }
  }

  private cleanupOldLogs(): void {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    try {
      const files = fs.readdirSync(this.logDir)
      for (const file of files) {
        if (!file.endsWith('.log')) continue
        const filePath = path.join(this.logDir, file)
        try {
          const stat = fs.statSync(filePath)
          if (stat.mtime.getTime() < cutoff) {
            fs.unlinkSync(filePath)
            console.log(`[Logger] Deleted old log: ${file}`)
          }
        } catch {}
      }
    } catch {}
  }

  private cleanupOversizedLogs(): void {
    const categories: LogCategory[] = ALL_LOG_CATEGORIES
    for (const cat of categories) {
      const filePath = this.getLogFile(cat)
      try {
        const stat = fs.statSync(filePath)
        if (stat.size > LOG_FILE_MAX_SIZE) {
          const content = fs.readFileSync(filePath, 'utf-8')
          const lines = content.split('\n').filter(Boolean)
          const keep = lines.slice(-LOG_KEEP_LINES)
          fs.writeFileSync(filePath, keep.join('\n') + '\n')
          console.log(`[Logger] Truncated oversized log: ${cat}.log`)
        }
      } catch {}
    }
  }

  getLogDir(): string {
    return this.logDir
  }
}

export const logger = new Logger()
