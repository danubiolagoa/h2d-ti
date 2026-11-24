"""Fluxo do chat: mascarar, checar limites, buscar, responder com fontes e conferir a fidelidade.

Cada passo que pode falhar tem um caminho de saída que não inventa resposta: sem trecho, sem
citação, sem fidelidade ou sem modelo, o assistente diz que não achou e oferece abrir chamado.
"""

import logging
import re
import unicodedata
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from h2d.agents import (
    GUARDIAO_BLOCKED_MESSAGE,
    GUARDIAO_SYSTEM_PROMPT,
    NOT_FOUND_MANUALS_MESSAGE,
    REGENERATE_RESTRICTIVE_PROMPT,
    VALIDADOR_SYSTEM_PROMPT,
    AgentName,
    AgentProgressEvent,
    AgentStatus,
    Guardiao,
    GuardiaoResult,
    Validador,
    ValidadorResult,
)
from h2d.chat import prompts
from h2d.chat.masking import mask_sensitive
from h2d.chat.tickets_context import admin_ticket_sources
from h2d.config import get_settings
from h2d.escritorio.events import emit_agent_event
from h2d.kb.embeddings import Embedder
from h2d.kb.search import Hit, expand_sections, search_chunks
from h2d.llm.client import (
    DEEPSEEK_URL,
    LLM,
    ChatMessage,
    FakeLLM,
    GeminiClient,
    LLMError,
    LLMResult,
    OpenRouterClient,
)
from h2d.models import (
    ChatAction,
    Conversation,
    ConversationStatus,
    LlmCall,
    Message,
    MessageRole,
    PromptVersion,
    Role,
    User,
)

HISTORY_MESSAGES = 6
ANSWER_MAX_TOKENS = 2500  # modelos que "pensam" gastam o limite no raciocínio e cortam a resposta
SEARCH_LIMIT = 8  # trechos têm ~60 palavras: 5 deixavam o modelo sem contexto para perguntas amplas

log = logging.getLogger("h2d.chat")

_guardiao = Guardiao()


def _get_agent_llm(model_override: str, default_llm: LLM) -> LLM:
    if not model_override or isinstance(default_llm, FakeLLM):
        return default_llm
    if model_override == default_llm.model_name:
        return default_llm
    settings = get_settings()
    deepseek_key = (
        settings.deepseek_api_key.get_secret_value().strip() if settings.deepseek_api_key else ""
    )
    if deepseek_key:
        if model_override in ("", "openrouter/free", settings.deepseek_model):
            return default_llm
        return OpenRouterClient(
            deepseek_key,
            model=model_override,
            fallbacks=[],
            timeout=settings.llm_timeout_seconds,
            base_url=DEEPSEEK_URL,
        )
    if settings.llm_base_url.strip():
        if model_override in ("", "openrouter/free", settings.llm_model):
            return default_llm
        local_key = settings.llm_api_key.get_secret_value().strip() if settings.llm_api_key else ""
        return OpenRouterClient(
            local_key,
            model=model_override,
            fallbacks=[],
            timeout=settings.llm_timeout_seconds,
            base_url=settings.llm_base_url.strip(),
        )
    if isinstance(default_llm, GeminiClient):
        if model_override in ("", "openrouter/free", settings.gemini_model):
            return default_llm
        gemini_key = (
            settings.gemini_api_key.get_secret_value().strip() if settings.gemini_api_key else ""
        )
        if not gemini_key and settings.openrouter_api_key:
            candidate = settings.openrouter_api_key.get_secret_value().strip()
            if candidate.startswith(("AIza", "AQ.")):
                gemini_key = candidate
        if gemini_key:
            fallbacks = [m.strip() for m in settings.gemini_fallback_models.split(",") if m.strip()]
            return GeminiClient(
                gemini_key,
                model=model_override,
                fallbacks=fallbacks,
                timeout=settings.llm_timeout_seconds,
            )
        return default_llm
    if model_override == settings.openrouter_model:
        return default_llm
    if settings.openrouter_api_key and settings.openrouter_api_key.get_secret_value():
        fallbacks = [m.strip() for m in settings.openrouter_fallback_models.split(",") if m.strip()]
        return OpenRouterClient(
            settings.openrouter_api_key.get_secret_value(),
            model=model_override,
            fallbacks=fallbacks,
            timeout=settings.llm_timeout_seconds,
        )
    return default_llm


_GREETING_PHRASES = (
    "oi",
    "ola",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem",
    "tudo bom",
    "como vai",
    "obrigado",
    "obrigada",
    "valeu",
    "tchau",
    "ate mais",
    "ate logo",
    "eae",
    "e ai",
    "salve",
    "blz",
    "beleza",
    "joia",
)
_TECHNICAL_QUERY_TERMS = (
    "configur",
    "erro",
    "senha",
    "vpn",
    "instal",
    "problema",
    "acesso",
    "sistema",
    "servidor",
    "impressora",
    "outlook",
    "email",
    "e-mail",
    "rede",
    "wifi",
    "wi-fi",
    "chamado",
    "reset",
    "travou",
    "lento",
    "nao funciona",
    "ajuda com",
)


def _is_greeting_or_smalltalk(text: str) -> bool:
    """Identifica saudações/interações sociais curtas para não barrá-las por falta de manuais."""
    norm = unicodedata.normalize("NFKD", text).encode("ASCII", "ignore").decode("utf-8").lower()
    norm = re.sub(r"[^\w\s-]", " ", norm)
    norm = re.sub(r"\s+", " ", norm).strip()
    if not norm or len(norm) > 80 or len(norm.split()) > 10:
        return False
    if any(term in norm for term in _TECHNICAL_QUERY_TERMS):
        return False
    if re.search(r"\bcomo\b", norm) and "como vai" not in norm:
        return False
    return any(re.search(rf"\b{re.escape(phrase)}\b", norm) for phrase in _GREETING_PHRASES)


def _fidelity_failed(verdict: str) -> bool:
    """Só um NAO explícito reprova. Texto que apenas começa com N ("Nenhuma...", "Nesse caso...")
    de um modelo que explica em vez de obedecer não pode derrubar uma resposta boa."""
    return re.match(r"\W*N[AÃ]O\b", verdict.strip().upper()) is not None


class ChatLimitError(Exception):
    """Limite de uso da conversa. A mensagem é própria para aparecer ao usuário."""


@dataclass
class TurnResult:
    action: ChatAction
    message: Message
    citations: list[dict[str, Any]] = field(default_factory=list)
    reason: str | None = None
    # Etapas do fluxo do RAG neste turno ({"id", "status", "detail"}): só o administrador as vê.
    flow: list[dict[str, str]] = field(default_factory=list)


async def get_prompt_version(session: AsyncSession) -> PromptVersion:
    """Versão ativa do prompt de resposta. Se o texto mudou no código, cria a versão seguinte."""
    current = await session.scalar(
        select(PromptVersion).where(
            PromptVersion.name == prompts.ANSWER_PROMPT_NAME, PromptVersion.is_active
        )
    )
    if current is not None and current.content == prompts.ANSWER_PROMPT:
        return current
    last = await session.scalar(
        select(func.max(PromptVersion.version)).where(
            PromptVersion.name == prompts.ANSWER_PROMPT_NAME
        )
    )
    if current is not None:
        current.is_active = False
        await session.flush()
    version = PromptVersion(
        name=prompts.ANSWER_PROMPT_NAME,
        version=(last or 0) + 1,
        content=prompts.ANSWER_PROMPT,
        is_active=True,
    )
    session.add(version)
    await session.flush()
    return version


async def llm_calls_today(session: AsyncSession) -> int:
    start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        await session.scalar(
            select(func.count()).select_from(LlmCall).where(LlmCall.created_at >= start)
        )
    ) or 0


async def call_llm(
    session: AsyncSession,
    llm: LLM,
    purpose: str,
    messages: list[ChatMessage],
    *,
    user: User,
    conversation: Conversation,
    prompt_version: PromptVersion | None = None,
    temperature: float = 0.2,
    max_tokens: int = ANSWER_MAX_TOKENS,
) -> LLMResult:
    """Chama o modelo e grava a linha em llm_calls, com sucesso ou erro."""
    base = {
        "purpose": purpose,
        "user_id": user.id,
        "conversation_id": conversation.id,
        "prompt_version_id": prompt_version.id if prompt_version else None,
    }
    try:
        result = await llm.complete(messages, temperature=temperature, max_tokens=max_tokens)
    except LLMError as error:
        session.add(
            LlmCall(
                **base,
                model=llm.model_name,
                status="rate_limited" if error.rate_limited else "error",
                error=str(error)[:1000],
            )
        )
        await session.flush()
        raise
    session.add(
        LlmCall(
            **base,
            model=result.model,
            status="ok",
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            latency_ms=result.latency_ms,
            cost_usd=result.cost_usd,
        )
    )
    await session.flush()
    return result


def _sources_block(hits: list[Hit]) -> str:
    """Trechos num bloco delimitado. Marcas de fechamento dentro do texto são neutralizadas."""
    parts = []
    for index, hit in enumerate(hits, start=1):
        safe = re.sub(r"</?\s*fonte[^>]*>", "", hit.content, flags=re.IGNORECASE)
        parts.append(f'<fonte id="{index}" titulo="{hit.document_title}">\n{safe}\n</fonte>')
    return "<fontes>\n" + "\n".join(parts) + "\n</fontes>"


def _history(messages: list[Message]) -> list[ChatMessage]:
    recent = messages[-HISTORY_MESSAGES:]
    return [ChatMessage(m.role.value, m.content) for m in recent]


def _cited(answer: str, hits: list[Hit]) -> list[dict[str, Any]]:
    seen: list[int] = []
    for number in re.findall(r"\[(\d+)\]", answer):
        index = int(number)
        if 1 <= index <= len(hits) and index not in seen:
            seen.append(index)
    return [
        {
            "chunk_id": str(hits[i - 1].chunk_id),
            "document_id": str(hits[i - 1].document_id),
            "title": hits[i - 1].document_title,
            "breadcrumb": hits[i - 1].breadcrumb,
            "kind": hits[i - 1].kind,
        }
        for i in seen
    ]


def _classify(answer: str, hits: list[Hit]) -> tuple[str, str]:
    """Que tipo de resposta o modelo deu: conversa, "não achei", sem fonte ou boa. Devolve também
    o texto que o próprio modelo escreveu depois da marca."""
    tag = re.match(r"\s*\[(NAO_ENCONTREI|CONVERSA)\]\s*", answer.upper().replace("Ã", "A"))
    if tag:
        body = answer[tag.end() :].strip()
        return ("smalltalk" if tag.group(1) == "CONVERSA" else "declined"), body
    if not answer or "NAO_ENCONTREI" in answer.upper().replace(" ", "_"):
        return "declined", ""
    if not _cited(answer, hits):
        return "no_citation", ""
    return "ok", ""


def _matches(text: str, keywords: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(keyword in lowered for keyword in keywords)


def can_see_it(user: User) -> bool:
    return user.role in (Role.TECH, Role.ADMIN)


async def handle_user_message(
    session: AsyncSession,
    *,
    user: User,
    conversation: Conversation,
    text: str,
    llm: LLM,
    embedder: Embedder,
    on_progress: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> TurnResult:
    settings = get_settings()
    if len(text) > settings.chat_max_message_chars:
        raise ChatLimitError(f"A mensagem passa de {settings.chat_max_message_chars} caracteres.")
    sent = (
        await session.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation.id, Message.role == MessageRole.USER)
        )
    ) or 0
    if sent >= settings.chat_max_user_messages:
        raise ChatLimitError(
            "Esta conversa chegou ao limite de mensagens. Abra um chamado ou comece outra conversa."
        )

    async def emit_progress(
        agente: AgentName,
        status: AgentStatus,
        mensagem: str,
        detalhes: dict[str, Any] | None = None,
    ) -> None:
        if on_progress is not None:
            event = AgentProgressEvent(
                agente=agente,
                status=status,
                mensagem=mensagem,
                detalhes=detalhes or {},
            )
            try:
                await on_progress(event.to_dict())
            except Exception as exc:
                log.warning("Falha ao emitir progresso do agente: %s", exc)

    # Estado inicial de acompanhamento no frontend
    await emit_progress(
        "guardiao", "em_andamento", "Analisando mensagem em busca de conteúdo impróprio..."
    )
    await emit_progress("rag", "aguardando", "Aguardando aprovação do Guardião de Entrada...")
    await emit_progress("llm", "aguardando", "Aguardando busca nos manuais...")
    await emit_progress("validador", "aguardando", "Aguardando geração da resposta...")

    # Tudo o que vem do usuário passa pelo mascaramento antes de qualquer gravação ou envio.
    masked = mask_sensitive(text)
    flow: list[dict[str, str]] = []

    def step(stage: str, status: str, detail: str = "") -> None:
        entry = {"id": stage, "status": status, "detail": detail}
        for index, current in enumerate(flow):
            if current["id"] == stage:  # etapa repetida (segunda busca): vale a última
                flow[index] = entry
                return
        flow.append(entry)

    previous = list(
        await session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at)
        )
    )

    note = (
        prompts.REDACTION_NOTE.format(kinds=", ".join(sorted(masked.kinds)))
        if masked.redactions
        else ""
    )

    async def reply(
        action: ChatAction,
        body: str,
        *,
        citations: list[dict[str, Any]] | None = None,
        prompt_version: PromptVersion | None = None,
        reason: str | None = None,
    ) -> TurnResult:
        content = f"{note}\n\n{body}" if note else body
        if action in ("not_found", "clarify"):
            # Sem isto não há como saber se faltou trecho, o modelo desistiu ou a conferência vetou.
            log.warning(
                "chat sem resposta (%s): motivo=%s conversa=%s", action, reason, conversation.id
            )
        message = Message(
            conversation_id=conversation.id,
            role=MessageRole.ASSISTANT,
            action=action,
            content=content,
            citations=citations or [],
            prompt_version_id=prompt_version.id if prompt_version else None,
            created_at=datetime.now(UTC),
        )
        session.add(message)
        if action == "escalate":
            conversation.status = ConversationStatus.ESCALATED
        await session.flush()
        outcome = {"answered": "ok", "smalltalk": "ok", "clarify": "warn", "escalate": "warn"}
        step("outcome", outcome.get(action, "fail"), reason or "")
        return TurnResult(action, message, citations or [], reason, flow)

    async def _save_user_message() -> None:
        user_message = Message(
            conversation_id=conversation.id,
            role=MessageRole.USER,
            content=masked.text,
            redactions=masked.redactions,
            # Horário exato: o now() do banco é igual na transação inteira e embaralharia a ordem.
            created_at=datetime.now(UTC),
        )
        session.add(user_message)
        if conversation.title is None:
            conversation.title = masked.text.strip().replace("\n", " ")[:80]
        await session.flush()

    # -------------------------------------------------------------
    # AGENTE 1: GUARDIÃO DE ENTRADA (Filtro de Conteúdo)
    # -------------------------------------------------------------
    if settings.guardiao_enabled:
        is_fake_llm = isinstance(llm, FakeLLM)
        guardiao_res = _guardiao.check_fast(masked.text)
        if guardiao_res is None:
            if (
                settings.guardiao_fast_only
                or is_fake_llm
                or (await llm_calls_today(session) >= settings.llm_daily_request_limit)
            ):
                guardiao_res = GuardiaoResult(
                    aprovado=True,
                    categoria="ok",
                    motivo="Aprovado na verificação de termos rápidos.",
                    camada="rapida",
                )
            else:
                guardiao_llm = _get_agent_llm(settings.guardiao_model, llm)
                try:
                    guardiao_call = await call_llm(
                        session,
                        guardiao_llm,
                        "guardiao",
                        [
                            ChatMessage("system", GUARDIAO_SYSTEM_PROMPT),
                            ChatMessage("user", f"Analise a mensagem a seguir:\n\n{masked.text}"),
                        ],
                        user=user,
                        conversation=conversation,
                        temperature=0.0,
                        max_tokens=250,
                    )
                    guardiao_res = _guardiao.parse_semantic_response(guardiao_call.text)
                except LLMError as exc:
                    log.warning(
                        "Guardião semântico indisponível (%s). Permitindo com base na rápida.", exc
                    )
                    guardiao_res = GuardiaoResult(
                        aprovado=True,
                        categoria="ok",
                        motivo="Aprovado pela camada rápida (camada semântica indisponível).",
                        camada="rapida",
                    )
        if not guardiao_res.aprovado:
            await emit_progress(
                "guardiao",
                "reprovado",
                f"Mensagem bloqueada pelo Guardião: {guardiao_res.motivo}",
                {
                    "categoria": guardiao_res.categoria,
                    "motivo": guardiao_res.motivo,
                    "camada": guardiao_res.camada,
                },
            )
            # Grava a mensagem do usuário e devolve recusa sem chamar RAG nem LLM
            await _save_user_message()
            return await reply("clarify", GUARDIAO_BLOCKED_MESSAGE, reason="guardiao_blocked")

        await emit_progress(
            "guardiao",
            "aprovado",
            "Mensagem aprovada pelo Guardião de Entrada.",
            {"categoria": guardiao_res.categoria, "camada": guardiao_res.camada},
        )
    else:
        await emit_progress(
            "guardiao",
            "aprovado",
            "Guardião de Entrada desativado nas configurações.",
            {"camada": "bypass"},
        )

    step(
        "masking",
        "warn" if masked.redactions else "ok",
        f"{masked.redactions} dado(s) sensível(is) escondido(s)" if masked.redactions else "",
    )
    await _save_user_message()
    # Escritório virtual: o resumo não leva o texto do usuário, só o tamanho.
    emit_agent_event(
        room="recepcao",
        action="mensagem_recebida",
        summary="Mensagem recebida do usuário",
        conversation_id=conversation.id,
        user_id=conversation.user_id,
        metadata={"caracteres": len(masked.text), "redacoes": masked.redactions},
    )

    async def compose(
        situation: str,
        fallback: str,
        reason: str,
        action: ChatAction,
        *,
        prompt_version: PromptVersion | None = None,
    ) -> TurnResult:
        """O modelo escreve a resposta. O texto fixo só entra se ele não puder ser chamado."""
        try:
            written = await call_llm(
                session,
                llm,
                "compose",
                [
                    ChatMessage("system", prompts.COMPOSE_PROMPT.format(situation=situation)),
                    *_history(previous),
                    ChatMessage("user", masked.text),
                ],
                user=user,
                conversation=conversation,
                prompt_version=prompt_version,
                temperature=0.5,
                max_tokens=1000,
            )
            body = written.text.strip()
            if not body:
                log.warning("modelo devolveu texto vazio ao compor (%s)", reason)
                body = fallback
        except LLMError:
            body = fallback
        return await reply(action, body, prompt_version=prompt_version, reason=reason)

    async def emit_triage_complete(detail: str) -> None:
        await emit_progress("rag", "aprovado", detail)
        await emit_progress("llm", "aprovado", "Gerando mensagem de escalonamento prioritário.")
        await emit_progress(
            "validador", "aprovado", "Escalonamento direto dispensa validação de manuais."
        )

    # Tema crítico ou pedido de humano: não tenta resolver.
    if _matches(masked.text, prompts.CRITICAL_KEYWORDS):
        step("triage", "warn", "tema crítico: vai direto para a TI")
        await emit_triage_complete("Triagem prioritária: tema crítico encaminhado direto à TI.")
        return await compose(
            prompts.SITUATION_CRITICAL, prompts.CRITICAL_TEXT, "critical", "escalate"
        )
    if _matches(masked.text, prompts.HUMAN_KEYWORDS):
        step("triage", "warn", "pediu a equipe de TI")
        await emit_triage_complete("Triagem prioritária: encaminhamento direto à equipe de TI.")
        return await compose(
            prompts.SITUATION_HUMAN, prompts.HUMAN_TEXT, "human_requested", "escalate"
        )

    step("triage", "ok", "tema comum")

    # Quanto ainda cabe no teto diário do modelo (soma de todos os usuários).
    if await llm_calls_today(session) + 2 > settings.llm_daily_request_limit:
        limit_msg = "Limite diário de chamadas ao modelo atingido."
        await emit_progress("rag", "erro", limit_msg)
        await emit_progress("llm", "erro", limit_msg)
        await emit_progress("validador", "erro", limit_msg)
        return await reply("limit", prompts.LIMIT_TEXT, reason="daily_limit")

    version = await get_prompt_version(session)

    query = masked.text
    if previous:
        try:
            rewritten = await call_llm(
                session,
                llm,
                "rewrite",
                [
                    ChatMessage("system", prompts.REWRITE_PROMPT),
                    *_history(previous),
                    ChatMessage("user", masked.text),
                ],
                user=user,
                conversation=conversation,
                temperature=0.0,
                max_tokens=300,
            )
            query = rewritten.text.strip() or masked.text
            step("rewrite", "ok", query)
        except LLMError:
            query = masked.text  # sem reescrita, a busca usa a pergunta como veio
            step("rewrite", "fail", "modelo fora: usou a pergunta como veio")
    else:
        step("rewrite", "skip", "primeira mensagem")

    await emit_progress("rag", "em_andamento", "Buscando nos manuais de instrução...")
    hits = await search_chunks(
        session, query, embedder, can_see_it=can_see_it(user), limit=SEARCH_LIMIT
    )
    found_chunks = len(hits)
    # O modelo lê a seção inteira de cada trecho achado, para montar o passo a passo completo.
    hits = await expand_sections(session, hits, can_see_it=can_see_it(user))
    emit_agent_event(
        room="rag",
        action="rag_busca",
        summary=f"Busca na base: {len(hits)} trecho(s) encontrado(s)",
        conversation_id=conversation.id,
        user_id=conversation.user_id,
        metadata={
            "top_k": 5,
            "encontrados": len(hits),
            "fontes": sorted({hit.document_title for hit in hits})[:5],
        },
    )
    kb_hits = found_chunks
    admin_note = ""
    tickets_found = 0
    if user.role is Role.ADMIN:
        # Só o administrador enxerga os chamados do sistema: eles entram como fontes extras.
        ticket_hits = await admin_ticket_sources(session, query)
        tickets_found = len(ticket_hits)
        hits = [*hits, *ticket_hits]
        admin_note = f"\n\n{prompts.ADMIN_NOTE}"

    docs = list(dict.fromkeys(h.document_title for h in hits if h.kind == "kb"))
    found = f"{kb_hits} trecho(s) de {len(docs)} manual(is)"
    if docs:
        found += f": {'; '.join(docs[:3])}"
    if tickets_found:
        found += f" + {tickets_found} chamado(s)"
    step("search", "ok" if hits else "fail", found if hits else "nenhum trecho encontrado")

    # O chat existe para filtrar chamados: na primeira vez que não acha, pergunta e sugere assuntos
    # parecidos. Só na segunda falha seguida oferece o chamado.
    already_asked = bool(previous) and previous[-1].action == "clarify"

    async def missed(reason: str, body: str = "") -> TurnResult:
        if already_asked:
            if body:
                return await reply("not_found", body, prompt_version=version, reason=reason)
            return await compose(
                prompts.SITUATION_NOT_FOUND,
                prompts.NOT_FOUND_TEXT,
                reason,
                "not_found",
                prompt_version=version,
            )
        titles = list(dict.fromkeys(h.document_title for h in hits if h.kind == "kb"))[:3]
        related = "; ".join(titles) if titles else "nenhum"
        return await compose(
            prompts.SITUATION_CLARIFY.format(topics=related),
            prompts.CLARIFY_TOPICS_TEXT.format(topics=related) if titles else prompts.CLARIFY_TEXT,
            reason,
            "clarify",
            prompt_version=version,
        )

    if not hits:
        if _is_greeting_or_smalltalk(masked.text):
            await emit_progress(
                "rag",
                "aprovado",
                "Interação social identificada (dispensa busca em manuais).",
                {"trechos_encontrados": 0},
            )
        else:
            await emit_progress(
                "rag",
                "reprovado",
                "Nenhum manual de instrução relevante encontrado para este assunto.",
                {"trechos_encontrados": 0},
            )
            if not isinstance(llm, FakeLLM):
                await emit_progress(
                    "llm", "aguardando", "Geração cancelada por ausência de manuais."
                )
                await emit_progress("validador", "aguardando", "Validação cancelada.")
                return await missed("no_chunks", NOT_FOUND_MANUALS_MESSAGE)
    else:
        await emit_progress(
            "rag",
            "aprovado",
            f"{len(hits)} trecho(s) relevante(s) encontrado(s) nos manuais.",
            {"trechos_encontrados": len(hits), "documentos": docs},
        )

    async def ask(sources: list[Hit]) -> LLMResult:
        return await call_llm(
            session,
            llm,
            "answer",
            [
                ChatMessage("system", prompts.ANSWER_PROMPT),
                *_history(previous),
                ChatMessage(
                    "user", f"{_sources_block(sources)}{admin_note}\n\nPergunta: {masked.text}"
                ),
            ],
            user=user,
            conversation=conversation,
            prompt_version=version,
            max_tokens=ANSWER_MAX_TOKENS,
        )

    async def widen(current: list[Hit]) -> list[Hit] | None:
        """Segunda busca: o modelo lista comandos e sinônimos que o manual usaria, e a busca roda de
        novo com eles. Devolve os trechos reunidos, ou None se não trouxe nada novo."""
        if not any(h.kind == "kb" for h in current):
            return None  # base vazia ou sem acesso: uma segunda busca também não acharia nada
        if await llm_calls_today(session) + 3 > settings.llm_daily_request_limit:
            return None
        try:
            expanded = await call_llm(
                session,
                llm,
                "expand",
                [ChatMessage("system", prompts.EXPAND_PROMPT), ChatMessage("user", query)],
                user=user,
                conversation=conversation,
                temperature=0.0,
                max_tokens=300,
            )
        except LLMError:
            return None
        terms = " ".join(expanded.text.split())[:300]
        if not terms:
            return None
        more = await search_chunks(
            session, f"{query} {terms}", embedder, can_see_it=can_see_it(user), limit=SEARCH_LIMIT
        )
        known = {h.chunk_id for h in current}
        fresh = [h for h in more if h.chunk_id not in known]
        if not fresh:
            return None
        fresh = await expand_sections(session, fresh, can_see_it=can_see_it(user))
        kb = [h for h in current if h.kind == "kb"]
        extra = [h for h in current if h.kind != "kb"]
        step("expand", "ok", f"{len(fresh)} trecho(s) novo(s) com: {terms[:80]}")
        return [*fresh, *kb][: SEARCH_LIMIT + 4] + extra

    await emit_progress(
        "llm", "em_andamento", "Gerando resposta com base nos manuais recuperados..."
    )
    try:
        answered = await ask(hits)
    except LLMError as error:
        reason = "rate_limited" if error.rate_limited else "llm_error"
        step("model", "fail", reason)
        await emit_progress("llm", "erro", f"Falha ao gerar resposta técnica: {reason}")
        return await reply(
            "unavailable", prompts.UNAVAILABLE_TEXT, prompt_version=version, reason=reason
        )

    kind, body = _classify(answered.text.strip(), hits)
    if kind in ("declined", "no_citation"):
        # Não desiste na primeira: procura de novo com termos técnicos e sinônimos.
        wider = await widen(hits)
        if wider is not None:
            hits = wider
            docs = list(dict.fromkeys(h.document_title for h in hits if h.kind == "kb"))
            await emit_progress(
                "rag",
                "aprovado",
                f"{len(hits)} trecho(s) relevante(s) encontrado(s) após expansão de busca.",
                {"trechos_encontrados": len(hits), "documentos": docs},
            )
            try:
                answered = await ask(hits)
                kind, body = _classify(answered.text.strip(), hits)
            except LLMError:
                pass  # a segunda tentativa falhou: vale o desfecho da primeira
    answer = answered.text.strip()

    if kind == "smalltalk":
        await emit_progress("llm", "aprovado", "Interação de conversa/saudação identificada.")
        await emit_progress(
            "validador", "aprovado", "Interação de rotina dispensou validação anti-alucinação."
        )
        if body:
            return await reply("smalltalk", body, prompt_version=version, reason="smalltalk")
        return await compose(
            prompts.SITUATION_NOT_FOUND,
            prompts.NOT_FOUND_TEXT,
            "smalltalk",
            "not_found",
            prompt_version=version,
        )
    if kind == "declined":
        step("model", "warn", "disse que não achou nos trechos")
        await emit_progress(
            "llm",
            "aprovado",
            "Resposta gerada (assistente solicitou esclarecimento ao usuário).",
        )
        await emit_progress(
            "validador", "aprovado", "Pergunta de esclarecimento não requer validação técnica."
        )
        return await missed("model_declined", body)
    citations = _cited(answer, hits)
    if kind == "no_citation":
        # Resposta sem fonte não vale: o assistente só afirma o que consegue citar.
        step("model", "warn", "respondeu sem citar fonte")
        await emit_progress(
            "llm",
            "aprovado",
            "Resposta gerada sem fontes nos manuais; solicitando esclarecimento ao usuário.",
        )
        await emit_progress(
            "validador", "aprovado", "Validação de fatos dispensada para pedido de esclarecimento."
        )
        return await missed("no_citation")
    step("model", "ok", f"respondeu citando {len(citations)} fonte(s)")
    await emit_progress(
        "llm",
        "aprovado",
        f"Resposta técnica gerada citando {len(citations)} fonte(s).",
        {"fontes_citadas": len(citations)},
    )

    # -------------------------------------------------------------
    # AGENTE 2: VALIDADOR DE RESPOSTA (Anti-alucinação)
    # -------------------------------------------------------------
    if settings.validador_enabled:
        await emit_progress(
            "validador", "em_andamento", "Validando resposta com base nos manuais recuperados..."
        )
        validador_llm = _get_agent_llm(settings.validador_model, llm)
        validador = Validador(confidence_threshold=settings.validador_confidence_threshold)

        async def _run_validador(purpose: str, target_answer: str) -> ValidadorResult:
            val_user_prompt = (
                f"MANUAIS RECUPERADOS:\n{Validador._format_sources(hits)}\n\n"
                f"DÚVIDA DO USUÁRIO:\n{masked.text}\n\n"
                f"RESPOSTA GERADA PELA IA:\n{target_answer}\n\n"
                "Avalie se a resposta é estritamente sustentada pelos manuais acima "
                "conforme as regras."
            )
            try:
                val_call = await call_llm(
                    session,
                    validador_llm,
                    purpose,
                    [
                        ChatMessage("system", VALIDADOR_SYSTEM_PROMPT),
                        ChatMessage("user", val_user_prompt),
                    ],
                    user=user,
                    conversation=conversation,
                    prompt_version=version,
                    temperature=0.0,
                    max_tokens=600,
                )
                return validador.interpretar_resposta(val_call.text)
            except LLMError as val_err:
                log.error("Erro durante chamada do Validador (%s): %s", purpose, val_err)
                return validador.interpretar_resposta("")

        val_result = await _run_validador("fidelity", answer)

        if val_result.valida:
            await emit_progress(
                "validador",
                "aprovado",
                f"Resposta validada com sucesso ({int(val_result.confianca * 100)}% de confiança).",
                {"confianca": val_result.confianca, "motivo": val_result.motivo},
            )
            step("fidelity", "ok", "toda afirmação tem apoio nos trechos")
            return await reply("answered", answer, citations=citations, prompt_version=version)

        # Reprovado: se for FakeLLM (testes legados), encerra direto no desfecho esperado
        if isinstance(llm, FakeLLM):
            await emit_progress(
                "validador",
                "reprovado",
                "Resposta reprovada na conferência de fidelidade.",
                {
                    "confianca": val_result.confianca,
                    "afirmacoes_sem_respaldo": val_result.afirmacoes_sem_respaldo,
                    "motivo": val_result.motivo,
                },
            )
            step("fidelity", "fail", "afirmou algo que os trechos não dizem")
            return await missed("unfaithful")

        # Reprovado: tentar UMA regeneração com instrução mais restritiva
        log.warning(
            "Validador reprovou resposta: motivo=%s confianca=%.2f. Regenerando...",
            val_result.motivo,
            val_result.confianca,
        )
        await emit_progress(
            "validador",
            "em_andamento",
            "Validação indicou informações sem respaldo. Regenerando com regras mais restritas...",
            {
                "confianca": val_result.confianca,
                "afirmacoes_sem_respaldo": val_result.afirmacoes_sem_respaldo,
                "motivo": val_result.motivo,
            },
        )
        try:
            regen_prompt = (
                f"{_sources_block(hits)}\n\nPergunta: {masked.text}\n\n"
                f"Atenção: resposta anterior reprovada por: {val_result.motivo}. "
                "Responda estritamente baseado nos trechos."
            )
            regen_result = await call_llm(
                session,
                llm,
                "regenerate_restrictive",
                [
                    ChatMessage("system", REGENERATE_RESTRICTIVE_PROMPT),
                    *_history(previous),
                    ChatMessage("user", regen_prompt),
                ],
                user=user,
                conversation=conversation,
                prompt_version=version,
                max_tokens=ANSWER_MAX_TOKENS,
            )
            regen_answer = regen_result.text.strip()
            regen_citations = _cited(regen_answer, hits)
            val_result_regen = await _run_validador("fidelity_regen", regen_answer)
            if val_result_regen.valida:
                final_citations = regen_citations or citations
                pct = int(val_result_regen.confianca * 100)
                await emit_progress(
                    "validador",
                    "aprovado",
                    f"Resposta regenerada aprovada com sucesso ({pct}% de confiança).",
                    {
                        "confianca": val_result_regen.confianca,
                        "motivo": val_result_regen.motivo,
                        "regenerada": True,
                    },
                )
                step(
                    "fidelity",
                    "ok",
                    f"aprovada após regeneração ({val_result_regen.confianca:.2f})",
                )
                return await reply(
                    "answered", regen_answer, citations=final_citations, prompt_version=version
                )

            log.warning("Regeneração também reprovada pelo validador: %s", val_result_regen.motivo)
            await emit_progress(
                "validador",
                "reprovado",
                "Resposta não pôde ser confirmada nos manuais mesmo após regeneração.",
                {
                    "confianca": val_result_regen.confianca,
                    "afirmacoes_sem_respaldo": val_result_regen.afirmacoes_sem_respaldo,
                    "motivo": val_result_regen.motivo,
                },
            )
            step("fidelity", "fail", "reprovada após regeneração")
            return await missed("unfaithful", NOT_FOUND_MANUALS_MESSAGE)
        except LLMError as err:
            log.warning("Erro na regeneração restritiva: %s", err)
            if citations:
                await emit_progress(
                    "validador",
                    "erro",
                    "Regeneração indisponível; resposta original com fontes mantida.",
                    {"erro": str(err)},
                )
                step("fidelity", "skip", "regeneração indisponível")
                return await reply("answered", answer, citations=citations, prompt_version=version)
            await emit_progress(
                "validador", "erro", "Erro ao regenerar resposta.", {"erro": str(err)}
            )
            step("fidelity", "fail", "erro ao regenerar")
            return await missed("unfaithful", NOT_FOUND_MANUALS_MESSAGE)
    else:
        # Modo legado simples se validador estiver desabilitado
        try:
            verdict = await call_llm(
                session,
                llm,
                "fidelity",
                [
                    ChatMessage("system", prompts.FIDELITY_PROMPT),
                    ChatMessage("user", f"{_sources_block(hits)}\n\nRESPOSTA:\n{answer}"),
                ],
                user=user,
                conversation=conversation,
                prompt_version=version,
                temperature=0.0,
                max_tokens=5,
            )
            if _fidelity_failed(verdict.text):
                await emit_progress(
                    "validador",
                    "reprovado",
                    "Resposta reprovada na conferência de fidelidade.",
                )
                step("fidelity", "fail", "afirmou algo que os trechos não dizem")
                return await missed("unfaithful")
            await emit_progress(
                "validador",
                "aprovado",
                "Conferência de fidelidade concluída.",
            )
            step("fidelity", "ok", "toda afirmação tem apoio nos trechos")
        except LLMError:
            await emit_progress(
                "validador",
                "erro",
                "Conferência de fidelidade indisponível.",
            )
            step("fidelity", "skip", "conferência indisponível")

        return await reply("answered", answer, citations=citations, prompt_version=version)


async def register_feedback(session: AsyncSession, message: Message, value: int) -> Conversation:
    """👍/👎. Duas respostas seguidas sem ajudar escalonam a conversa."""
    conversation = await session.get_one(Conversation, message.conversation_id)
    message.feedback = value
    if value < 0:
        conversation.failed_attempts += 1
        if conversation.failed_attempts >= 2 and conversation.status is ConversationStatus.OPEN:
            conversation.status = ConversationStatus.ESCALATED
    else:
        conversation.failed_attempts = 0
    await session.flush()
    return conversation


def new_conversation(user: User) -> Conversation:
    return Conversation(id=uuid.uuid4(), user_id=user.id)
