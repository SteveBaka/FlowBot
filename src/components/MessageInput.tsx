/**
 * 消息输入组件
 * 支持文本消息发送和图片上传
 */
import React, { useState, useRef, useCallback } from 'react'
import { Send, Image as ImageIcon, Smile, Paperclip, X } from 'lucide-react'
import './MessageInput.css'

interface MessageInputProps {
  sessionId: string
  onSendMessage?: (message: { sessionId: string; content: string; type: string; imagePath?: string }) => Promise<void>
  disabled?: boolean
}

export const MessageInput: React.FC<MessageInputProps> = ({
  sessionId,
  onSendMessage,
  disabled = false,
}) => {
  const [content, setContent] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value)
    // 自动调整高度
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'
  }, [])

  const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setImageFile(file)
      const reader = new FileReader()
      reader.onload = (event) => {
        setImagePreview(event.target?.result as string)
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const clearImage = useCallback(() => {
    setImageFile(null)
    setImagePreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [])

  const handleSend = useCallback(async () => {
    if (disabled || sending) return

    const trimmedContent = content.trim()
    if (!trimmedContent && !imageFile) return

    setSending(true)
    try {
      if (onSendMessage) {
        await onSendMessage({
          sessionId,
          content: trimmedContent || (imageFile ? '[图片]' : ''),
          type: imageFile ? 'image' : 'text',
          imagePath: imageFile ? imageFile.name : undefined,
        })
      }
      setContent('')
      clearImage()
      // 重置 textarea 高度
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    } catch (error) {
      console.error('Failed to send message:', error)
    } finally {
      setSending(false)
    }
  }, [content, imageFile, sessionId, onSendMessage, disabled, sending, clearImage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  return (
    <div className="message-input-container">
      {imagePreview && (
        <div className="message-input-preview">
          <img src={imagePreview} alt="Preview" className="preview-image" />
          <button className="preview-remove" onClick={clearImage}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="message-input-wrapper">
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          onChange={handleImageSelect}
          style={{ display: 'none' }}
        />
        <button
          className="message-input-action"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sending}
          title="发送图片"
        >
          <ImageIcon size={20} />
        </button>
        <textarea
          ref={textareaRef}
          className="message-input-textarea"
          value={content}
          onChange={handleContentChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
          disabled={disabled || sending}
          rows={1}
        />
        <button
          className="message-input-send"
          onClick={handleSend}
          disabled={disabled || sending || (!content.trim() && !imageFile)}
          title="发送消息"
        >
          {sending ? (
            <div className="sending-spinner" />
          ) : (
            <Send size={20} />
          )}
        </button>
      </div>
    </div>
  )
}

export default MessageInput
