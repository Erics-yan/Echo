import { useState, useEffect, useRef, useCallback } from 'react'
import { Message, WSPayload, ConnectionStatus, PendingAction, ChatSession } from '../types/chat'

interface UseChatOptions {
  apiBaseUrl: string
  wsBaseUrl: string
  shopId: string
  email: string
  orderId?: string
}

interface UseChatReturn {
  messages: Message[]
  connectionStatus: ConnectionStatus
  isTyping: boolean
  session: ChatSession | null
  csatPrompt: boolean
  sendMessage: (text: string) => void
  confirmAction: (actionId: string) => Promise<void>
  submitCsat: (score: number) => Promise<void>
}

export function useChat({
  apiBaseUrl,
  wsBaseUrl,
  shopId,
  email,
  orderId,
}: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([])
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [isTyping, setIsTyping] = useState(false)
  const [session, setSession] = useState<ChatSession | null>(null)
  const [csatPrompt, setCsatPrompt] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectCountRef = useRef(0)
  const MAX_RECONNECT = 5

  const addMessage = useCallback((msg: Omit<Message, 'id' | 'timestamp'>) => {
    setMessages(prev => [
      ...prev,
      { ...msg, id: crypto.randomUUID(), timestamp: new Date() },
    ])
  }, [])

  const initSession = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/chat/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, shop_id: shopId, order_id: orderId }),
      })
      if (!res.ok) throw new Error('Session creation failed')
      const data: ChatSession = await res.json()
      setSession(data)
      return data
    } catch (err) {
      setConnectionStatus('error')
      return null
    }
  }, [apiBaseUrl, email, shopId, orderId])

  const connect = useCallback(async (sessionId: string) => {
    setConnectionStatus('connecting')
    const ws = new WebSocket(`${wsBaseUrl}/api/chat/ws/${sessionId}`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnectionStatus('connected')
      // Heartbeat ping every 25s
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 25000)
    }

    ws.onmessage = (event) => {
      const payload: WSPayload = JSON.parse(event.data)

      switch (payload.type) {
        case 'connected':
          break

        case 'typing':
          setIsTyping(!!payload.typing)
          break

        case 'message':
          setIsTyping(false)
          addMessage({
            role: 'assistant',
            content: payload.content!,
            intent: payload.intent,
            action: payload.action,
          })
          break

        case 'csat_prompt':
          setCsatPrompt(true)
          break

        case 'error':
          setIsTyping(false)
          addMessage({
            role: 'assistant',
            content: payload.message || 'Something went wrong. Please try again.',
          })
          break

        case 'pong':
          break
      }
    }

    ws.onerror = () => {
      setConnectionStatus('error')
    }

    ws.onclose = () => {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)
      if (reconnectCountRef.current >= MAX_RECONNECT) {
        setConnectionStatus('error')
        return
      }
      reconnectCountRef.current += 1
      setConnectionStatus('disconnected')
      // Auto-reconnect after 3 seconds
      reconnectTimerRef.current = setTimeout(() => {
        if (sessionId) connect(sessionId)
      }, 3000)
    }
  }, [wsBaseUrl, addMessage])

  // Initialize on mount
  useEffect(() => {
    let sessionId: string | null = null

    const init = async () => {
      const sess = await initSession()
      if (!sess) return
      sessionId = sess.session_id

      addMessage({
        role: 'assistant',
        content: sess.welcome_message,
      })

      await connect(sess.session_id)
    }

    init()

    return () => {
      wsRef.current?.close()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback((text: string) => {
    if (!text.trim() || connectionStatus !== 'connected') return
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

    wsRef.current.send(JSON.stringify({ type: 'message', content: text }))
  }, [connectionStatus])

  const confirmAction = useCallback(async (actionId: string) => {
    if (!session) return
    const res = await fetch(`${apiBaseUrl}/api/chat/confirm-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_id: actionId, session_id: session.session_id }),
    })
    const data = await res.json()
    if (data.status === 'success') {
      addMessage({
        role: 'assistant',
        content: `✓ Refund of $${data.amount_usd?.toFixed(2)} has been processed. It will arrive in ${data.estimated_arrival}.`,
      })
    } else {
      addMessage({
        role: 'assistant',
        content: data.message || 'There was an issue processing your request.',
      })
    }
  }, [apiBaseUrl, session, addMessage])

  const submitCsat = useCallback(async (score: number) => {
    if (!session) return
    await fetch(`${apiBaseUrl}/api/chat/csat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.session_id, score }),
    })
    setCsatPrompt(false)
  }, [apiBaseUrl, session])

  return {
    messages,
    connectionStatus,
    isTyping,
    session,
    csatPrompt,
    sendMessage,
    confirmAction,
    submitCsat,
  }
}
