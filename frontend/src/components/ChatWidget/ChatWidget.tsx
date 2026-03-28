import React, { useState, useRef, useEffect } from 'react'
import { useChat } from '../../hooks/useChat'
import { Message, PendingAction, WidgetConfig } from '../../types/chat'
import styles from './ChatWidget.module.css'

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className={styles.typingWrapper}>
      <div className={styles.avatar}>AI</div>
      <div className={styles.typingBubble}>
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </div>
    </div>
  )
}

function ActionConfirmCard({
  action,
  onConfirm,
  onDismiss,
}: {
  action: PendingAction
  onConfirm: () => void
  onDismiss: () => void
}) {
  const { payload } = action
  const isRefund = payload.type === 'refund_confirm'
  const isCancel = payload.type === 'cancel_confirm'

  return (
    <div className={styles.actionCard}>
      <p className={styles.actionTitle}>
        {isRefund && `Confirm refund of $${payload.amount?.toFixed(2)}`}
        {isCancel && `Confirm cancellation of order #${payload.order_id}`}
      </p>
      <p className={styles.actionSub}>
        {isRefund && 'Funds will return to your original payment method in 3–5 business days.'}
        {isCancel && 'This action cannot be undone after confirmation.'}
      </p>
      <div className={styles.actionButtons}>
        <button className={styles.btnConfirm} onClick={onConfirm}>
          ✓ Confirm
        </button>
        <button className={styles.btnDismiss} onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  onConfirmAction,
}: {
  message: Message
  onConfirmAction: (actionId: string) => void
}) {
  const isUser = message.role === 'user'
  const [actionDismissed, setActionDismissed] = useState(false)

  return (
    <div className={`${styles.messageRow} ${isUser ? styles.userRow : styles.botRow}`}>
      {!isUser && <div className={styles.avatar}>AI</div>}
      <div className={`${styles.bubble} ${isUser ? styles.userBubble : styles.botBubble}`}>
        <span dangerouslySetInnerHTML={{ __html: formatMessage(message.content) }} />
        {message.action && !actionDismissed && (
          <ActionConfirmCard
            action={message.action}
            onConfirm={() => {
              onConfirmAction(message.action!.action_id)
              setActionDismissed(true)
            }}
            onDismiss={() => setActionDismissed(true)}
          />
        )}
      </div>
      {isUser && <div className={styles.userAvatar}>You</div>}
    </div>
  )
}

function CsatPanel({ onSubmit }: { onSubmit: (score: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null)
  const labels = ['Terrible', 'Poor', 'Okay', 'Good', 'Excellent']

  return (
    <div className={styles.csatPanel}>
      <p className={styles.csatTitle}>How was your experience?</p>
      <div className={styles.csatStars}>
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            className={`${styles.star} ${selected !== null && n <= selected ? styles.starActive : ''}`}
            onClick={() => setSelected(n)}
            title={labels[n - 1]}
          >
            ★
          </button>
        ))}
      </div>
      {selected && (
        <button className={styles.csatSubmit} onClick={() => onSubmit(selected)}>
          Submit feedback
        </button>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  const color = {
    connected: '#22c55e',
    connecting: '#f59e0b',
    disconnected: '#94a3b8',
    error: '#ef4444',
  }[status] || '#94a3b8'

  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginRight: 6,
      }}
    />
  )
}

// ─── Main Widget ──────────────────────────────────────────────────────────────

interface ChatWidgetProps {
  config: WidgetConfig
  userEmail: string
  orderId?: string
}

export function ChatWidget({ config, userEmail, orderId }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const {
    messages,
    connectionStatus,
    isTyping,
    csatPrompt,
    sendMessage,
    confirmAction,
    submitCsat,
  } = useChat({
    apiBaseUrl: config.apiBaseUrl,
    wsBaseUrl: config.wsBaseUrl,
    shopId: config.shopId,
    email: userEmail,
    orderId,
  })

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  const handleSend = () => {
    if (!input.trim()) return
    sendMessage(input.trim())
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const primaryColor = config.primaryColor || '#2E75B6'
  const position = config.position || 'bottom-right'

  return (
    <>
      {/* Launcher button */}
      <button
        className={styles.launcher}
        style={{
          background: primaryColor,
          right: position === 'bottom-right' ? 24 : undefined,
          left: position === 'bottom-left' ? 24 : undefined,
        }}
        onClick={() => setIsOpen(o => !o)}
        aria-label="Open chat"
      >
        {isOpen ? '✕' : '💬'}
      </button>

      {/* Widget panel */}
      {isOpen && (
        <div
          className={styles.panel}
          style={{
            right: position === 'bottom-right' ? 24 : undefined,
            left: position === 'bottom-left' ? 24 : undefined,
          }}
        >
          {/* Header */}
          <div className={styles.header} style={{ background: primaryColor }}>
            <div>
              <div className={styles.headerTitle}>Customer Support</div>
              <div className={styles.headerSub}>
                <StatusDot status={connectionStatus} />
                {connectionStatus === 'connected' ? 'AI Assistant · Online' : connectionStatus === 'connecting' ? '连接中...' : connectionStatus === 'disconnected' ? '已断开' : '连接错误'}
              </div>
            </div>
            <button className={styles.headerClose} onClick={() => setIsOpen(false)}>✕</button>
          </div>

          {/* Privacy notice */}
          <div className={styles.privacyBanner}>
            🤖 You're chatting with an AI. For complex issues, we'll connect you with our team.
          </div>

          {/* Messages */}
          <div className={styles.messages}>
            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                message={msg}
                onConfirmAction={confirmAction}
              />
            ))}
            {isTyping && <TypingIndicator />}
            {csatPrompt && <CsatPanel onSubmit={submitCsat} />}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className={styles.inputRow}>
            <input
              ref={inputRef}
              className={styles.input}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message..."
              disabled={connectionStatus !== 'connected'}
              maxLength={500}
              aria-label="Chat message"
            />
            <button
              className={styles.sendBtn}
              style={{ background: primaryColor }}
              onClick={handleSend}
              disabled={!input.trim() || connectionStatus !== 'connected'}
              aria-label="Send message"
            >
              ➤
            </button>
          </div>

          <div className={styles.footer}>
            Powered by AI · <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMessage(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>')
}
