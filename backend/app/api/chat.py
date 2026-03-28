from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, EmailStr
from typing import Optional
import json
import uuid

from app.core.database import get_db
from app.core.cache import CacheService, get_redis
from app.models.models import User, Session as ChatSession, SessionStatus, UserTier
from app.services.agent import process_message
from app.tools.tools import tool_confirm_action, ShopifyClient
from app.core.config import settings

router = APIRouter(prefix="/api/chat", tags=["chat"])


# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class SessionCreateRequest(BaseModel):
    email: EmailStr
    shop_id: str
    order_id: Optional[str] = None


class SessionCreateResponse(BaseModel):
    session_id: str
    user_id: str
    language: str
    welcome_message: str


class ActionConfirmRequest(BaseModel):
    action_id: str
    session_id: str


class CSATRequest(BaseModel):
    session_id: str
    score: int  # 1-5


# ─── Session creation ─────────────────────────────────────────────────────────

@router.post("/session", response_model=SessionCreateResponse)
async def create_session(
    request: SessionCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create or resume a chat session for a user."""
    # Find or create user
    result = await db.execute(
        select(User).where(
            User.email == request.email,
            User.shop_id == request.shop_id,
        )
    )
    user = result.scalar_one_or_none()

    if not user:
        user = User(
            email=request.email,
            shop_id=request.shop_id,
            tier=UserTier.FIRST_TIME,
        )
        db.add(user)
        await db.flush()

    # Create new session
    session = ChatSession(
        user_id=user.id,
        shop_id=request.shop_id,
    )
    db.add(session)
    await db.flush()

    tier = user.tier.value
    if tier == "high_value":
        welcome = "Welcome back! 👋 As a valued customer, I'm here to help with anything you need."
    elif tier == "first_time":
        welcome = "Hi there! Welcome! 😊 I'm your AI assistant. I can help you track orders, process returns, and answer any questions."
    else:
        welcome = "Hi! I'm your AI assistant. How can I help you today?"

    return SessionCreateResponse(
        session_id=session.id,
        user_id=user.id,
        language=session.language,
        welcome_message=welcome,
    )


# ─── WebSocket endpoint ───────────────────────────────────────────────────────

@router.websocket("/ws/{session_id}")
async def websocket_chat(
    websocket: WebSocket,
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    await websocket.accept()

    redis_client = await get_redis()
    cache = CacheService(redis_client)

    try:
        # Load session + user
        session_result = await db.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        )
        session = session_result.scalar_one_or_none()

        if not session or session.status != SessionStatus.ACTIVE:
            await websocket.send_json({"error": "invalid_session"})
            return

        user_result = await db.execute(
            select(User).where(User.id == session.user_id)
        )
        user = user_result.scalar_one_or_none()

        # Minimal Shopify client (shop_id maps to access token in prod)
        shopify_client = ShopifyClient(
            shop_domain=f"{session.shop_id}.myshopify.com",
            access_token=settings.SHOPIFY_API_KEY,  # per-shop token in production
        )

        await websocket.send_json({"type": "connected", "session_id": session_id})

        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)

            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if data.get("type") != "message":
                continue

            user_text = data.get("content", "").strip()
            if not user_text:
                continue

            # Typing indicator
            await websocket.send_json({"type": "typing", "typing": True})

            try:
                # Reload session messages for context
                session_result = await db.execute(
                    select(ChatSession).where(ChatSession.id == session_id)
                )
                session = session_result.scalar_one()

                agent_response = await process_message(
                    user_message=user_text,
                    session=session,
                    user=user,
                    db=db,
                    cache=cache,
                    shopify_client=shopify_client,
                )
                await db.commit()

                payload = {
                    "type": "message",
                    "content": agent_response.message,
                    "intent": agent_response.intent,
                    "language": agent_response.language,
                    "session_id": session_id,
                }

                if agent_response.requires_action:
                    payload["action"] = {
                        "action_id": agent_response.action_id,
                        "payload": agent_response.action_payload,
                    }

                if agent_response.should_escalate:
                    payload["escalated"] = True

                await websocket.send_json({"type": "typing", "typing": False})
                await websocket.send_json(payload)

                # Prompt CSAT after resolution
                if agent_response.should_escalate or (
                    agent_response.intent in ("ORDER_STATUS",) and not agent_response.requires_action
                ):
                    await websocket.send_json({
                        "type": "csat_prompt",
                        "message": "How would you rate this interaction?",
                    })

            except Exception as e:
                await db.rollback()
                await websocket.send_json({
                    "type": "error",
                    "message": "I encountered an issue. Let me connect you with our team.",
                    "code": "agent_error",
                })

    except WebSocketDisconnect:
        pass
    finally:
        await websocket.close()


# ─── Action confirmation ──────────────────────────────────────────────────────

@router.post("/confirm-action")
async def confirm_action(
    request: ActionConfirmRequest,
    db: AsyncSession = Depends(get_db),
):
    """User clicked 'Confirm' on a pending action (refund/cancel)."""
    redis_client = await get_redis()
    cache = CacheService(redis_client)

    session_result = await db.execute(
        select(ChatSession).where(ChatSession.id == request.session_id)
    )
    session = session_result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    user_result = await db.execute(select(User).where(User.id == session.user_id))
    user = user_result.scalar_one_or_none()

    result = await tool_confirm_action(
        action_id=request.action_id,
        db=db,
        cache=cache,
        shop_id=session.shop_id,
        user_email=user.email if user else "unknown",
    )
    await db.commit()
    return result


# ─── CSAT submission ──────────────────────────────────────────────────────────

@router.post("/csat")
async def submit_csat(
    request: CSATRequest,
    db: AsyncSession = Depends(get_db),
):
    if not 1 <= request.score <= 5:
        raise HTTPException(status_code=422, detail="Score must be 1-5")

    result = await db.execute(
        select(ChatSession).where(ChatSession.id == request.session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session.csat_score = request.score
    if request.score >= 4:
        session.status = SessionStatus.RESOLVED
    return {"status": "recorded", "score": request.score}


# ─── Chat history ─────────────────────────────────────────────────────────────

@router.get("/history/{session_id}")
async def get_history(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        "session_id": session_id,
        "status": session.status.value,
        "language": session.language,
        "messages": [
            {
                "id": m.id,
                "role": m.role.value,
                "content": m.content,
                "intent": m.intent,
                "timestamp": m.created_at.isoformat(),
            }
            for m in session.messages
        ],
    }
