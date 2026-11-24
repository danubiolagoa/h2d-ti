import { api } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";

export type Citation = components["schemas"]["Citation"];
export type TicketRef = components["schemas"]["TicketRef"];
export type ConversationStatus = components["schemas"]["ConversationStatus"];

export type ChatAction = NonNullable<components["schemas"]["MessageOut"]["action"]>;

export type FlowStatus = "ok" | "warn" | "fail" | "skip";

export type AgentName = "guardiao" | "rag" | "llm" | "validador";
export type AgentStatus = "aguardando" | "em_andamento" | "aprovado" | "reprovado" | "erro";

export interface AgentProgressEvent {
  agente: AgentName;
  status: AgentStatus;
  mensagem: string;
  detalhes?: Record<string, unknown>;
  timestamp: string;
}

/** Uma etapa do fluxo do RAG no turno (só o administrador recebe). */
export interface FlowStep {
  id: string;
  status: FlowStatus;
  detail: string;
}

export interface StreamHandlers {
  onToken: (text: string) => void;
  onSources: (citations: Citation[]) => void;
  onFlow?: (steps: FlowStep[]) => void;
  onAgentProgress?: (event: AgentProgressEvent) => void;
  onDone: (done: {
    message_id: string;
    action: ChatAction;
    conversation_status: ConversationStatus;
    ticket: TicketRef | null;
  }) => void;
  onError: (detail: string) => void;
}

function parseEvent(block: string): { event: string; data: unknown } | null {
  const lines = block.split("\n");
  const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
  if (!event || data === undefined) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

/**
 * Envia a mensagem e lê a resposta em SSE. Usa fetch (e não EventSource) porque o envio é um POST.
 * Os eventos chegam na ordem: status, token (vários), sources, flow (só administrador), done. Um erro de limite vem como
 * evento "error".
 */
export async function sendMessage(
  conversationId: string,
  content: string,
  handlers: StreamHandlers,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ content }),
    });
  } catch {
    handlers.onError("Sem conexão com o servidor.");
    return;
  }
  if (!response.ok || !response.body) {
    const body: unknown = await response.json().catch(() => null);
    const detail = (body as { detail?: unknown } | null)?.detail;
    handlers.onError(
      response.status === 409
        ? "Esta conversa já foi encerrada ou encaminhada à TI."
        : typeof detail === "string"
          ? detail
          : "Não foi possível enviar a mensagem.",
    );
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  for (;;) {
    const chunk = await reader.read().catch(() => null);
    if (!chunk || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const parsed = parseEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      if (!parsed) continue;
      const data = parsed.data as Record<string, unknown>;
      if (parsed.event === "token") handlers.onToken(String(data.text ?? ""));
      else if (parsed.event === "sources") handlers.onSources((data.citations as Citation[]) ?? []);
      else if (parsed.event === "flow") handlers.onFlow?.((data.steps as FlowStep[]) ?? []);
      else if (parsed.event === "agent_progress") handlers.onAgentProgress?.(data as unknown as AgentProgressEvent);
      else if (parsed.event === "done") {
        finished = true;
        handlers.onDone(data as unknown as Parameters<StreamHandlers["onDone"]>[0]);
      } else if (parsed.event === "error") {
        finished = true;
        handlers.onError(String(data.detail ?? "Erro ao responder."));
      }
    }
  }
  reader.releaseLock();
  if (!finished) {
    handlers.onError("A conexão com o assistente foi encerrada antes de a resposta terminar. Tente novamente.");
  }
}

export async function listConversations() {
  const { data } = await api.GET("/api/chat/conversations");
  return data ?? [];
}

export async function createConversation(): Promise<string | null> {
  const { data } = await api.POST("/api/chat/conversations");
  return data?.id ?? null;
}

export async function sendFeedback(messageId: string, value: 1 | -1) {
  const { data } = await api.POST("/api/chat/messages/{message_id}/feedback", {
    params: { path: { message_id: messageId } },
    body: { value },
  });
  return data ?? null;
}

export async function escalate(conversationId: string): Promise<TicketRef | null> {
  const { data } = await api.POST("/api/chat/conversations/{conversation_id}/escalate", {
    params: { path: { conversation_id: conversationId } },
  });
  return data ?? null;
}

export async function resolveConversation(conversationId: string) {
  const { data } = await api.POST("/api/chat/conversations/{conversation_id}/resolve", {
    params: { path: { conversation_id: conversationId } },
  });
  return data ?? null;
}

export async function loadConversation(conversationId: string) {
  const { data } = await api.GET("/api/chat/conversations/{conversation_id}", {
    params: { path: { conversation_id: conversationId } },
  });
  return data ?? null;
}

export async function loadChunk(chunkId: string) {
  const { data } = await api.GET("/api/kb/chunks/{chunk_id}", {
    params: { path: { chunk_id: chunkId } },
  });
  return data ?? null;
}
