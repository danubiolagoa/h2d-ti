"""Chat: conversas do próprio usuário, mensagens com resposta em SSE e feedback."""

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from h2d.chat.service import (
    ChatLimitError,
    TurnResult,
    handle_user_message,
    new_conversation,
    register_feedback,
)
from h2d.config import get_settings
from h2d.deps import CurrentUser, SessionDep
from h2d.escritorio.events import emit_agent_event
from h2d.kb.embeddings import Embedder, get_embedder
from h2d.llm.client import LLM, get_llm
from h2d.models import ChatAction, Conversation, ConversationStatus, Message, Role, Ticket
from h2d.tickets.service import create_ticket_from_conversation

router = APIRouter(prefix="/chat", tags=["chat"])


def get_llm_dep() -> LLM:
    return get_llm()


def get_embedder_dep() -> Embedder:
    return get_embedder()


LLMDep = Annotated[LLM, Depends(get_llm_dep)]
EmbedderDep = Annotated[Embedder, Depends(get_embedder_dep)]


class Citation(BaseModel):
    chunk_id: uuid.UUID
    document_id: uuid.UUID
    title: str
    breadcrumb: str
    kind: str = "kb"


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    redactions: int
    citations: list[Citation]
    action: ChatAction | None
    feedback: int | None
    created_at: datetime


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: str | None
    status: ConversationStatus
    created_at: datetime
    updated_at: datetime


class TicketRef(BaseModel):
    id: uuid.UUID
    code: str
    status: str


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]
    ticket: TicketRef | None = None


class SendMessage(BaseModel):
    content: str = Field(min_length=1)


class FeedbackIn(BaseModel):
    value: int = Field(ge=-1, le=1)


def _message_out(message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        role=message.role.value,
        content=message.content,
        redactions=message.redactions,
        citations=[Citation(**c) for c in message.citations],
        action=message.action,
        feedback=message.feedback,
        created_at=message.created_at,
    )


async def _own_conversation(
    session: SessionDep, user: CurrentUser, conversation_id: uuid.UUID
) -> Conversation:
    conversation = await session.get(Conversation, conversation_id)
    # 404 também para conversa de outra pessoa: não revela que ela existe.
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversa não encontrada")
    await session.refresh(conversation)
    return conversation


@router.post(
    "/conversations", status_code=status.HTTP_201_CREATED, operation_id="createConversation"
)
async def create_conversation(session: SessionDep, user: CurrentUser) -> ConversationOut:
    conversation = new_conversation(user)
    session.add(conversation)
    await session.commit()
    await session.refresh(conversation)
    return ConversationOut.model_validate(conversation, from_attributes=True)


@router.get("/conversations", operation_id="listConversations")
async def list_conversations(session: SessionDep, user: CurrentUser) -> list[ConversationOut]:
    rows = await session.scalars(
        select(Conversation)
        .execution_options(populate_existing=True)
        .where(Conversation.user_id == user.id)
        .order_by(Conversation.updated_at.desc())
        .limit(50)
    )
    return [ConversationOut.model_validate(c, from_attributes=True) for c in rows]


@router.get("/conversations/{conversation_id}", operation_id="getConversation")
async def get_conversation(
    conversation_id: uuid.UUID, session: SessionDep, user: CurrentUser
) -> ConversationDetail:
    conversation = await _own_conversation(session, user, conversation_id)
    messages = await session.scalars(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at, Message.id)
    )
    ticket = await session.scalar(select(Ticket).where(Ticket.conversation_id == conversation.id))
    return ConversationDetail(
        **ConversationOut.model_validate(conversation, from_attributes=True).model_dump(),
        messages=[_message_out(m) for m in messages],
        ticket=_ticket_ref(ticket),
    )


def _ticket_ref(ticket: Ticket | None) -> TicketRef | None:
    return TicketRef(id=ticket.id, code=ticket.code, status=ticket.status.value) if ticket else None


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _chunks(text: str, size: int = 3) -> list[str]:
    words = text.split(" ")
    return [
        " ".join(words[i : i + size]) + (" " if i + size < len(words) else "")
        for i in range(0, len(words), size)
    ]


@router.post("/conversations/{conversation_id}/messages", operation_id="sendMessage")
async def send_message(
    conversation_id: uuid.UUID,
    body: SendMessage,
    session: SessionDep,
    user: CurrentUser,
    llm: LLMDep,
    embedder: EmbedderDep,
) -> StreamingResponse:
    """Responde em SSE: `status`, depois `token` (pedaços do texto), `sources` e `done`."""
    conversation = await _own_conversation(session, user, conversation_id)
    if conversation.status is not ConversationStatus.OPEN:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Esta conversa já foi encerrada ou encaminhada à TI"
        )

    async def stream() -> AsyncIterator[str]:
        yield _sse("status", {"step": "thinking"})
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        async def on_progress(event: dict[str, Any]) -> None:
            await queue.put(event)

        async def run_pipeline() -> TurnResult:
            try:
                return await handle_user_message(
                    session,
                    user=user,
                    conversation=conversation,
                    text=body.content,
                    llm=llm,
                    embedder=embedder,
                    on_progress=on_progress,
                )
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_pipeline())

        while True:
            item = await queue.get()
            if item is None:
                break
            yield _sse("agent_progress", item)

        try:
            result: TurnResult = await task
            await session.commit()
            await session.refresh(conversation)
            ticket = None
            if conversation.status is ConversationStatus.ESCALATED:
                # Escalonou (tema crítico, pedido de humano...): o chamado nasce na mesma resposta.
                ticket = await create_ticket_from_conversation(
                    session,
                    conversation=conversation,
                    requester=user,
                    llm=llm,
                    reason=result.reason or "escalonamento",
                )
                await session.commit()
                await session.refresh(conversation)
        except ChatLimitError as error:
            await session.rollback()
            yield _sse("error", {"detail": str(error)})
            return
        delay = get_settings().chat_stream_delay_seconds
        for piece in _chunks(result.message.content):
            yield _sse("token", {"text": piece})
            if delay:
                await asyncio.sleep(delay)
        yield _sse("sources", {"citations": result.citations})
        if user.role is Role.ADMIN:
            # O fluxo do RAG mostra manuais, pontuações e falhas do modelo: só o administrador.
            yield _sse("flow", {"steps": result.flow})
        emit_agent_event(
            room="recepcao",
            action="resposta_enviada",
            summary="Resposta enviada ao usuário",
            ticket_id=ticket.id if ticket is not None else None,
            conversation_id=conversation.id,
            user_id=user.id,
            metadata={"acao": result.action, "fontes": len(result.citations)},
        )
        yield _sse(
            "done",
            {
                "message_id": str(result.message.id),
                "action": result.action,
                "conversation_status": conversation.status.value,
                "ticket": (
                    _ticket_ref(ticket).model_dump(mode="json") if ticket is not None else None  # type: ignore[union-attr]
                ),
            },
        )

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"}
    )


@router.post("/messages/{message_id}/feedback", operation_id="sendFeedback")
async def feedback(
    message_id: uuid.UUID, body: FeedbackIn, session: SessionDep, user: CurrentUser, llm: LLMDep
) -> ConversationOut:
    message = await session.get(Message, message_id)
    conversation = await session.get(Conversation, message.conversation_id) if message else None
    if message is None or conversation is None or conversation.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mensagem não encontrada")
    if message.role.value != "assistant":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Só respostas do assistente")
    updated = await register_feedback(session, message, body.value)
    if updated.status is ConversationStatus.ESCALATED:
        await create_ticket_from_conversation(
            session,
            conversation=updated,
            requester=user,
            llm=llm,
            reason="duas respostas seguidas não ajudaram",
        )
    await session.commit()
    await session.refresh(updated)  # updated_at é preenchido pelo banco
    return ConversationOut.model_validate(updated, from_attributes=True)


@router.post("/conversations/{conversation_id}/resolve", operation_id="resolveConversation")
async def resolve(
    conversation_id: uuid.UUID, session: SessionDep, user: CurrentUser
) -> ConversationOut:
    conversation = await _own_conversation(session, user, conversation_id)
    if conversation.status is ConversationStatus.OPEN:
        conversation.status = ConversationStatus.RESOLVED
        await session.commit()
        await session.refresh(conversation)
    return ConversationOut.model_validate(conversation, from_attributes=True)


@router.post("/conversations/{conversation_id}/escalate", operation_id="escalateConversation")
async def escalate(
    conversation_id: uuid.UUID, session: SessionDep, user: CurrentUser, llm: LLMDep
) -> TicketRef:
    """ "Falar com a TI": classifica a conversa, abre o chamado e o roteia. Repetir não duplica."""
    conversation = await _own_conversation(session, user, conversation_id)
    ticket = await create_ticket_from_conversation(
        session,
        conversation=conversation,
        requester=user,
        llm=llm,
        reason="pedido do usuário",
    )
    await session.commit()
    await session.refresh(ticket)
    return TicketRef(id=ticket.id, code=ticket.code, status=ticket.status.value)
