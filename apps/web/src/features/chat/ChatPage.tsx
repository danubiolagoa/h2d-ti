import { useQuery } from "@tanstack/react-query";
import { Bot, CheckCircle2, FileText, Headset, LifeBuoy, Plus, SendHorizontal, ThumbsDown, ThumbsUp } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Markdown } from "@/components/Markdown";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, Drawer } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { meQuery } from "@/lib/auth";
import { cn } from "@/lib/utils";

import {
  type AgentProgressEvent,
  type ChatAction,
  type Citation,
  type ConversationStatus,
  createConversation,
  escalate,
  type FlowStep,
  listConversations,
  loadChunk,
  loadConversation,
  resolveConversation,
  sendFeedback,
  sendMessage,
  type TicketRef,
} from "./api";
import { AgentProgressPanel } from "./AgentProgressPanel";
import { RagFlowStrip } from "./RagFlowStrip";

interface UiMessage {
  key: string;
  id?: string; // id do servidor, quando já existe (necessário para o feedback)
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  feedback?: 1 | -1;
  action?: ChatAction;
  streaming?: boolean;
  agentEvents?: AgentProgressEvent[];
}

const GREETING =
  "Olá! Sou o assistente de TI. Descreva o problema e eu procuro a resposta nos manuais. Nunca informe sua senha por aqui.";

const OFFER_TICKET: ChatAction[] = ["not_found", "unavailable", "limit"];

const CHAT_SESSION_KEY = "h2d-chat-session";

interface ChatSessionSnapshot {
  userId: string | null;
  conversationId: string | null;
  messages: UiMessage[];
  draft: string;
  status: ConversationStatus;
  ticket: TicketRef | null;
  flow: FlowStep[] | null;
  startedNew: boolean;
}

const EMPTY_SESSION: ChatSessionSnapshot = {
  userId: null,
  conversationId: null,
  messages: [],
  draft: "",
  status: "open",
  ticket: null,
  flow: null,
  startedNew: false,
};

let memorySession: ChatSessionSnapshot | null = null;

function readChatSession(): ChatSessionSnapshot {
  if (memorySession) return memorySession;
  try {
    const raw = window.sessionStorage.getItem(CHAT_SESSION_KEY);
    if (!raw) return EMPTY_SESSION;
    const parsed = JSON.parse(raw) as Partial<ChatSessionSnapshot>;
    const restored: ChatSessionSnapshot = {
      userId: typeof parsed.userId === "string" ? parsed.userId : null,
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : null,
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.map((m) => ({ ...m, streaming: false }))
        : [],
      draft: typeof parsed.draft === "string" ? parsed.draft : "",
      status: parsed.status ?? "open",
      ticket: parsed.ticket ?? null,
      flow: Array.isArray(parsed.flow) ? parsed.flow : null,
      startedNew: Boolean(parsed.startedNew),
    };
    memorySession = restored;
    return restored;
  } catch {
    return EMPTY_SESSION;
  }
}

function writeChatSession(snapshot: ChatSessionSnapshot): void {
  memorySession = snapshot;
  try {
    const serializable: ChatSessionSnapshot = {
      ...snapshot,
      messages: snapshot.messages.map((m) => ({ ...m, streaming: false })),
    };
    window.sessionStorage.setItem(CHAT_SESSION_KEY, JSON.stringify(serializable));
  } catch {
    // sessionStorage indisponível ou cheio: cache em memória segue ativo
  }
}

export function resetChatSessionCache(): void {
  memorySession = null;
  try {
    window.sessionStorage.removeItem(CHAT_SESSION_KEY);
  } catch {
    // ignora erro em ambientes sem storage
  }
}

export function ChatPage() {
  const initial = readChatSession();
  const [conversationId, setConversationId] = useState<string | null>(initial.conversationId);
  const [messages, setMessages] = useState<UiMessage[]>(initial.messages);
  const [draft, setDraft] = useState(initial.draft);
  const [busy, setBusy] = useState(() => initial.messages.some((m) => m.streaming));
  const [status, setStatus] = useState<ConversationStatus>(initial.status);
  const [ticket, setTicket] = useState<TicketRef | null>(initial.ticket);
  const [error, setError] = useState<string | null>(null);
  const [openedChunk, setOpenedChunk] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowStep[] | null>(initial.flow);
  const [startedNew, setStartedNew] = useState(initial.startedNew);
  const { data: me } = useQuery(meQuery);
  const isAdmin = me?.role === "admin";
  const listEnd = useRef<HTMLLIElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const prev = readChatSession();
    if (me?.id && prev.userId && prev.userId !== me.id) {
      resetChatSessionCache();
      setConversationId(null);
      setMessages([]);
      setDraft("");
      setStatus("open");
      setTicket(null);
      setFlow(null);
      setStartedNew(false);
      return;
    }
    writeChatSession({
      userId: me?.id ?? prev.userId,
      conversationId,
      messages,
      draft,
      status,
      ticket,
      flow,
      startedNew,
    });
  }, [me?.id, conversationId, messages, draft, status, ticket, flow, startedNew]);

  useEffect(() => {
    if (!me?.id || conversationId || messages.length > 0 || startedNew) return;
    let active = true;
    void (async () => {
      const conversations = await listConversations();
      if (!active) return;
      const latestOpen =
        conversations.find((c) => c.status === "open" && c.title !== null) ??
        conversations.find((c) => c.status === "open");
      if (!latestOpen) return;
      const detail = await loadConversation(latestOpen.id);
      if (!active || !detail || detail.messages.length === 0) return;
      const restored: UiMessage[] = detail.messages.map((m) => ({
        key: m.id,
        id: m.id,
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
        citations: m.citations,
        feedback: m.feedback === 1 || m.feedback === -1 ? m.feedback : undefined,
      }));
      setConversationId(detail.id);
      setMessages(restored);
      setStatus(detail.status);
      setTicket(detail.ticket ?? null);
    })();
    return () => {
      active = false;
    };
  }, [me?.id, conversationId, messages.length, startedNew]);

  useEffect(() => {
    listEnd.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  const lastSources = [...messages].reverse().find((m) => m.role === "assistant" && m.citations.length > 0)?.citations ?? [];
  const closed = status !== "open";

  async function ensureConversation(): Promise<string | null> {
    if (conversationId) return conversationId;
    const id = await createConversation();
    if (id) {
      setConversationId(id);
      writeChatSession({ ...readChatSession(), userId: me?.id ?? null, conversationId: id });
    }
    return id;
  }

  async function refreshTicket(id: string) {
    const detail = await loadConversation(id);
    if (detail) {
      setStatus(detail.status);
      setTicket(detail.ticket ?? null);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || closed) return;
    setError(null);
    setBusy(true);
    setDraft("");
    setStartedNew(false);
    const id = await ensureConversation();
    if (!id) {
      setBusy(false);
      setError("Não foi possível iniciar a conversa.");
      return;
    }
    const assistantKey = crypto.randomUUID();
    const appended: UiMessage[] = [
      ...messages,
      { key: crypto.randomUUID(), role: "user", content: text, citations: [] },
      {
        key: assistantKey,
        role: "assistant",
        content: "",
        citations: [],
        streaming: true,
        agentEvents: [],
      },
    ];
    writeChatSession({
      ...readChatSession(),
      userId: me?.id ?? null,
      conversationId: id,
      messages: appended,
      draft: "",
      startedNew: false,
    });
    if (mountedRef.current) setMessages(appended);

    const update = (patch: (m: UiMessage) => UiMessage) => {
      const snap = readChatSession();
      const nextMessages = snap.messages.map((m) => (m.key === assistantKey ? patch(m) : m));
      writeChatSession({ ...snap, messages: nextMessages });
      if (mountedRef.current) setMessages(nextMessages);
    };

    await sendMessage(id, text, {
      onAgentProgress: (ev) =>
        update((m) => ({
          ...m,
          agentEvents: [...(m.agentEvents ?? []), ev],
        })),
      onToken: (piece) => update((m) => ({ ...m, content: m.content + piece })),
      onSources: (citations) => update((m) => ({ ...m, citations })),
      onFlow: (steps) => {
        writeChatSession({ ...readChatSession(), flow: steps });
        if (mountedRef.current) setFlow(steps);
      },
      onDone: (done) => {
        update((m) => ({ ...m, id: done.message_id, action: done.action, streaming: false }));
        writeChatSession({
          ...readChatSession(),
          status: done.conversation_status,
          ticket: done.ticket ?? readChatSession().ticket,
        });
        if (mountedRef.current) {
          setStatus(done.conversation_status);
          if (done.ticket) setTicket(done.ticket);
        }
      },
      onError: (detail) => {
        const snap = readChatSession();
        const filtered = snap.messages.filter((m) => m.key !== assistantKey);
        writeChatSession({ ...snap, messages: filtered });
        if (mountedRef.current) {
          setError(detail);
          setMessages(filtered);
        }
      },
    });
    update((m) => ({ ...m, streaming: false }));
    if (mountedRef.current) setBusy(false);
  }

  async function rate(message: UiMessage, value: 1 | -1) {
    if (!message.id || !conversationId) return;
    const updated = await sendFeedback(message.id, value);
    if (!updated) return toast("Não foi possível registrar o seu voto");
    setMessages((current) => current.map((m) => (m.key === message.key ? { ...m, feedback: value } : m)));
    setStatus(updated.status);
    if (updated.status === "escalated") {
      await refreshTicket(conversationId);
      toast("Encaminhado à TI", "Duas respostas não ajudaram, então abri um chamado.");
    }
  }

  async function talkToIt() {
    const id = await ensureConversation();
    if (!id) return toast("Não foi possível abrir o chamado");
    setBusy(true);
    const created = await escalate(id);
    setBusy(false);
    if (!created) return toast("Não foi possível abrir o chamado");
    setTicket(created);
    setStatus("escalated");
    toast(`Chamado ${created.code} aberto`, "A equipe de TI recebeu o resumo da conversa.");
  }

  async function markResolved() {
    if (!conversationId) return;
    const result = await resolveConversation(conversationId);
    if (result) setStatus(result.status);
  }

  function newConversation() {
    setConversationId(null);
    setMessages([]);
    setDraft("");
    setStatus("open");
    setTicket(null);
    setError(null);
    setFlow(null);
    setStartedNew(true);
    writeChatSession({
      ...EMPTY_SESSION,
      userId: me?.id ?? null,
      startedNew: true,
    });
  }

  return (
    <section>
      <PageHeader
        title="Assistente"
        description="Descreva o problema e receba a resposta com base nos manuais de TI."
        actions={
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {(messages.length > 0 || closed) && (
              <Button className="border border-border bg-surface" onClick={newConversation}>
                <Plus aria-hidden className="size-4" />
                Nova conversa
              </Button>
            )}
            <Button
              className="border border-border bg-surface"
              onClick={() => void talkToIt()}
              disabled={busy || ticket !== null}
            >
              <Headset aria-hidden className="size-4" />
              Falar com a TI
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
        <Card className="flex min-h-[60dvh] flex-col sm:min-h-[520px]">
          <ol aria-label="Conversa" className="flex-1 space-y-5 overflow-y-auto p-3 sm:p-5">
            <li className="flex gap-3">
              <BotAvatar />
              <p className="min-w-0 flex-1">{GREETING}</p>
            </li>
            {messages.map((message) =>
              message.role === "user" ? (
                <li key={message.key} className="flex justify-end">
                  <p className="min-w-0 max-w-[90%] rounded-2xl sm:max-w-[80%] rounded-br-sm bg-accent px-4 py-2.5 wrap-anywhere whitespace-pre-wrap text-accent-fg">
                    {message.content}
                  </p>
                </li>
              ) : (
                <li key={message.key} className="flex gap-3">
                  <BotAvatar />
                  <div className="min-w-0 flex-1 space-y-3">
                    {message.agentEvents && message.agentEvents.length > 0 && (
                      <AgentProgressPanel
                        events={message.agentEvents}
                        isStreaming={message.streaming}
                      />
                    )}
                    {message.content ? (
                      <Markdown>{message.content}</Markdown>
                    ) : message.streaming && (!message.agentEvents || message.agentEvents.length === 0) ? (
                      <p className="text-muted">Pensando…</p>
                    ) : null}
                    {message.citations.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {message.citations.map((citation, index) =>
                          citation.kind === "ticket" ? (
                            <Badge key={citation.chunk_id} tone="warn" title="Chamado do sistema">
                              <Headset aria-hidden className="size-3" />[{index + 1}] {citation.title}
                            </Badge>
                          ) : (
                            <button
                              key={citation.chunk_id}
                              type="button"
                              onClick={() => setOpenedChunk(citation.chunk_id)}
                              className="cursor-pointer"
                            >
                              <Badge tone="info">
                                <FileText aria-hidden className="size-3" />[{index + 1}] {citation.title}
                              </Badge>
                            </button>
                          ),
                        )}
                      </div>
                    )}
                    {!message.streaming && message.action && OFFER_TICKET.includes(message.action) && !ticket && (
                      <Button className="border border-border bg-surface" onClick={() => void talkToIt()} disabled={busy}>
                        <LifeBuoy aria-hidden className="size-4" />
                        Abrir um chamado
                      </Button>
                    )}
                    {!message.streaming && message.id && message.action === "answered" && (
                      <div className="flex items-center gap-1 text-xs text-muted">
                        <span className="mr-1">Resolveu?</span>
                        {(
                          [
                            [1, ThumbsUp, "Resposta útil"],
                            [-1, ThumbsDown, "Resposta não ajudou"],
                          ] as const
                        ).map(([value, Icon, label]) => (
                          <button
                            key={value}
                            type="button"
                            aria-label={label}
                            aria-pressed={message.feedback === value}
                            onClick={() => void rate(message, value)}
                            className={cn(
                              "flex size-8 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-2",
                              message.feedback === value && "bg-accent-soft text-accent",
                            )}
                          >
                            <Icon aria-hidden className="size-4" />
                          </button>
                        ))}
                        {!closed && message.feedback === 1 && (
                          <Button className="ml-1" onClick={() => void markResolved()}>
                            <CheckCircle2 aria-hidden className="size-4" />
                            Resolvido
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ),
            )}
            <li ref={listEnd} aria-hidden />
          </ol>

          {ticket && (
            <p role="status" className="mx-4 mb-3 rounded-lg bg-info/10 px-3 py-2 text-sm text-info">
              Chamado <strong>{ticket.code}</strong> aberto. Acompanhe em{" "}
              <Link to="/meus-chamados" className="underline">
                Meus chamados
              </Link>
              .
            </p>
          )}
          {status === "resolved" && (
            <p role="status" className="mx-4 mb-3 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
              Conversa encerrada como resolvida. Que bom que deu certo!
            </p>
          )}
          {error && (
            <p role="alert" className="mx-4 mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          <form onSubmit={(event) => void send(event)} className="flex gap-2 border-t border-border p-3 sm:p-4">
            <Input
              aria-label="Sua mensagem"
              placeholder={closed ? "Conversa encerrada. Comece uma nova." : "Descreva o problema. Nunca informe sua senha."}
              value={draft}
              maxLength={2000}
              disabled={closed}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              aria-label="Enviar"
              disabled={busy || closed || !draft.trim()}
              className="w-12 shrink-0 px-0"
            >
              <SendHorizontal aria-hidden className="size-[18px]" />
            </Button>
          </form>
          <p className="px-4 pb-3 text-xs text-muted">
            Respostas geradas por IA a partir dos manuais. Confira a fonte antes de seguir um procedimento.
          </p>
        </Card>
        {isAdmin && (
          <RagFlowStrip
            steps={flow}
            action={[...messages].reverse().find((m) => m.role === "assistant")?.action}
          />
        )}
        </div>

        <Card className="min-w-0 self-start">
          <CardHeader title="Fontes consultadas" description="Trechos usados na última resposta" />
          {lastSources.length === 0 ? (
            <p className="p-4 text-muted">As fontes aparecem aqui quando o assistente responde.</p>
          ) : (
            <ul className="divide-y divide-border">
              {lastSources.map((source, index) => (
                <li key={source.chunk_id}>
                  {source.kind === "ticket" ? (
                    <div className="space-y-1 p-4">
                      <p className="font-medium">
                        [{index + 1}] {source.title}
                      </p>
                      <p className="font-mono text-[11px] text-muted">{source.breadcrumb}</p>
                    </div>
                  ) : (
                  <button
                    type="button"
                    onClick={() => setOpenedChunk(source.chunk_id)}
                    className="w-full cursor-pointer space-y-1 p-4 text-left hover:bg-surface-2"
                  >
                    <p className="font-medium">
                      [{index + 1}] {source.title}
                    </p>
                    <p className="font-mono text-[11px] text-muted">{source.breadcrumb}</p>
                  </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ChunkDrawer chunkId={openedChunk} onClose={() => setOpenedChunk(null)} />
    </section>
  );
}

function BotAvatar() {
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
      <Bot className="size-[18px]" />
    </span>
  );
}

function ChunkDrawer({ chunkId, onClose }: { chunkId: string | null; onClose: () => void }) {
  const chunk = useQuery({
    queryKey: ["kb", "chunk", chunkId],
    queryFn: () => loadChunk(chunkId ?? ""),
    enabled: chunkId !== null,
  });
  return (
    <Drawer
      open={chunkId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={chunk.data?.document_title ?? "Fonte"}
      description={chunk.data?.breadcrumb}
    >
      {chunk.isPending && chunkId !== null && <p className="text-muted">Carregando…</p>}
      {chunk.isError || (chunk.isSuccess && !chunk.data) ? (
        <p role="alert" className="text-danger">
          Não foi possível abrir esta fonte.
        </p>
      ) : null}
      {chunk.data && <Markdown>{chunk.data.content}</Markdown>}
    </Drawer>
  );
}
