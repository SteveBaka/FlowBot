/**
 * 消息发送服务
 * 通过 IPC 调用主进程的 EnhancedMessageSender
 * 支持单条发送、批量发送、队列管理
 */

interface SendMessageOptions {
  sessionId: string
  content: string
  type?: 'text' | 'image' | 'voice' | 'video' | 'emoji' | 'file'
  atUsers?: string[]
  replyTo?: string
  imagePath?: string
  accessToken?: string
}

interface SendMessageResult {
  success: boolean
  messageId?: string
  timestamp?: number
  error?: string
}

/**
 * 发送单条消息
 */
export async function sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
  const { sessionId, content, imagePath } = options
  try {
    const result = await (window as any).electronAPI.chat.sendMessage(sessionId, content, imagePath)
    return {
      success: result.success,
      error: result.error,
      messageId: result.messageId,
      timestamp: result.timestamp,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 批量发送消息
 */
export async function sendBatch(tasks: Array<{ sessionId: string; content: string }>): Promise<{
  total: number; sent: number; failed: number
}> {
  return (window as any).electronAPI.chat.sendBatch(tasks)
}

/**
 * 取消发送队列
 */
export async function cancelSendQueue(): Promise<{ cancelled: number }> {
  return (window as any).electronAPI.chat.cancelSendQueue()
}

/**
 * 获取发送进度
 */
export async function getSendProgress(): Promise<{
  total: number; sent: number; failed: number; current?: string
}> {
  return (window as any).electronAPI.chat.sendProgress()
}

/**
 * 检查微信是否运行
 */
export async function isWeChatRunning(): Promise<boolean> {
  const result = await (window as any).electronAPI.chat.isWeChatRunning()
  return result.running
}
