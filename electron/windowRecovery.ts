// White-screen recovery for the containerized WeFlow app.
//
// Layers:
//  1. render-process-gone  -> log reason + reload (with crash-loop backoff)
//  2. unresponsive         -> timestamped log only (v1; no forced crash)
//  3. child-process-gone   -> log GPU/utility/network exits for diagnostics
//
// All output goes through the normal console pipeline (start.sh tee ->
// docker logs + data/logs/container.log).

import { app, type WebContents } from 'electron'

const TAG = '[WindowRecovery]'

let quitting = false

export function markQuitting() {
  quitting = true
}

// ─── crash-loop protection ────────────────────────────────────────────────────
// A poisoned page that crashes on every reload must not burn CPU forever:
// allow up to MAX_RELOADS_IN_WINDOW reloads per window, then back off
// exponentially (10s -> 120s) until the window goes quiet.

const CRASH_WINDOW_MS = 5 * 60 * 1000
const MAX_RELOADS_IN_WINDOW = 5
const BASE_BACKOFF_MS = 10_000
const MAX_BACKOFF_MS = 120_000

const crashTimestamps: number[] = []
let denyUntil = 0
let backoffMs = BASE_BACKOFF_MS

function allowReload(): boolean {
  const now = Date.now()
  if (now < denyUntil) return false
  while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_WINDOW_MS) {
    crashTimestamps.shift()
  }
  crashTimestamps.push(now)

  if (crashTimestamps.length > MAX_RELOADS_IN_WINDOW) {
    denyUntil = now + backoffMs
    console.error(
      `${TAG} crash loop detected (${crashTimestamps.length} crashes in ${Math.round(CRASH_WINDOW_MS / 1000)}s), recovery paused for ${Math.round(backoffMs / 1000)}s`
    )
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    return false
  }
  backoffMs = BASE_BACKOFF_MS
  return true
}

function safeUrl(contents: WebContents): string {
  try {
    return contents.getURL().slice(0, 120)
  } catch {
    return '(unknown)'
  }
}

export function attachWebContentsRecovery(contents: WebContents) {
  contents.on('render-process-gone', (_event, details) => {
    // 容器实测：renderer 被 kill 后 reason=killed，reload 可恢复到原 hash 路由
    if (quitting) return
    // clean-exit also fires for windows closed during normal shutdown
    if (details.reason === 'clean-exit') return

    console.error(
      `${TAG} renderer gone: reason=${details.reason} exitCode=${details.exitCode} url=${safeUrl(contents)}`
    )
    if (!allowReload()) return

    try {
      contents.reload()
      console.log(`${TAG} renderer reloaded`)
    } catch (e) {
      console.error(`${TAG} reload failed:`, e)
    }
  })

  contents.on('unresponsive', () => {
    // v1: log only. Heavy legit work (huge chat render) can trip this
    // spuriously; revisit force-crash once real hang patterns show in logs.
    console.warn(`${TAG} renderer unresponsive at ${new Date().toISOString()} url=${safeUrl(contents)}`)
  })

  contents.on('responsive', () => {
    console.log(`${TAG} renderer responsive again at ${new Date().toISOString()}`)
  })
}

export function initWindowRecovery() {
  // One hook covers every BrowserWindow (8+ creation sites) plus future ones
  app.on('web-contents-created', (_event, contents) => {
    attachWebContentsRecovery(contents)
  })

  app.on('child-process-gone', (_event, details) => {
    if (quitting) return
    console.error(
      `${TAG} child process gone: type=${details.type} name=${details.name || '-'} reason=${details.reason} exitCode=${details.exitCode ?? '-'}`
    )
  })
}
