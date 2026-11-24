import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPage, resetChatSessionCache } from "./ChatPage";

const USER = {
  id: "0190a000-0000-7000-8000-000000000001",
  name: "Ana Admin",
  email: "admin@h2d.local",
  role: "admin" as const,
  department: "TI",
};

const CONVERSATION = {
  id: "0190a000-0000-7000-8000-000000000099",
  title: "Acesso à VPN",
  status: "open",
  created_at: "2026-11-18T11:00:00Z",
  updated_at: "2026-11-18T11:00:00Z",
};

function requestPath(input: RequestInfo | URL) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(url, "http://localhost").pathname;
}

function sseStream(events: Array<{ event: string; data: unknown }>) {
  const payload = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatPage />
    </QueryClientProvider>,
  );
}

describe("ChatPage", () => {
  beforeEach(() => {
    resetChatSessionCache();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    resetChatSessionCache();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("restaura as ações das respostas ao recuperar o histórico do servidor", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      switch (requestPath(input)) {
        case "/api/auth/me":
          return Response.json(USER);
        case "/api/chat/conversations":
          return Response.json([CONVERSATION]);
        case `/api/chat/conversations/${CONVERSATION.id}`:
          return Response.json({
            ...CONVERSATION,
            messages: [
              { id: "1", role: "assistant", content: "Confira as configurações da VPN.", action: "answered", feedback: 1, citations: [] },
              { id: "2", role: "assistant", content: "Não encontrei essa informação.", action: "not_found", feedback: null, citations: [] },
              { id: "3", role: "assistant", content: "Bem-vinda!", action: null, feedback: null, citations: [] },
            ],
            ticket: null,
          });
        default:
          return new Response(null, { status: 404 });
      }
    }));

    renderChat();

    expect((await screen.findByRole("button", { name: "Resposta útil" })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Resolvido" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abrir um chamado" })).toBeTruthy();
    expect(screen.getByText("Bem-vinda!")).toBeTruthy();
  });

  it("libera o envio de outra mensagem quando a conexão cai durante a resposta", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      switch (requestPath(input)) {
        case "/api/auth/me":
          return Response.json(USER);
        case "/api/chat/conversations":
          return Response.json(input instanceof Request && input.method === "POST" ? CONVERSATION : []);
        case `/api/chat/conversations/${CONVERSATION.id}/messages`:
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"Resposta parcial"}\n\n'));
            },
            pull(controller) {
              controller.error(new TypeError("connection lost"));
            },
          }));
        default:
          return new Response(null, { status: 404 });
      }
    }));

    renderChat();
    const input = screen.getByRole("textbox", { name: "Sua mensagem" });
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Enviar" });
    await user.type(input, "Preciso de ajuda com a VPN");
    await user.click(send);

    expect((await screen.findByRole("alert")).textContent).toMatch(/conexão.*encerrada/i);
    expect(screen.queryByText("Resposta parcial")).toBeNull();
    await user.type(input, "Vou enviar outra mensagem");
    expect(send.disabled).toBe(false);
  });

  it("mantém o histórico da conversa e o painel de agentes ao desmontar e voltar para a tela", async () => {
    const convId = CONVERSATION.id;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = requestPath(input);

      if (pathname === "/api/auth/me") {
        return new Response(JSON.stringify(USER), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/api/chat/conversations") {
        const method = input instanceof Request ? input.method : "GET";
        if (method === "POST") {
          return new Response(
            JSON.stringify({
              id: convId,
              title: null,
              status: "open",
              created_at: "2026-11-18T11:00:00Z",
              updated_at: "2026-11-18T11:00:00Z",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === `/api/chat/conversations/${convId}/messages`) {
        return new Response(
          sseStream([
            {
              event: "agent_progress",
              data: {
                agente: "guardiao",
                status: "aprovado",
                mensagem: "Mensagem aprovada.",
                timestamp: "2026-11-18T11:00:00Z",
              },
            },
            { event: "token", data: { text: "Use df -h para ver o disco [1]." } },
            {
              event: "done",
              data: {
                message_id: "0190a000-0000-7000-8000-000000000100",
                action: "answered",
                conversation_status: "open",
                ticket: null,
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstMount = renderChat();
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Sua mensagem");
    await user.type(input, "Como verifico espaço em disco no Linux?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await screen.findByText(/Use df -h para ver o disco/)).toBeTruthy();
    expect(screen.getByText("Mensagem aprovada.")).toBeTruthy();

    // Simula troca de tela (desmonta ChatPage) e retorno para /chat (remonta ChatPage)
    firstMount.unmount();
    renderChat();

    await waitFor(() => {
      expect(screen.getByText("Como verifico espaço em disco no Linux?")).toBeTruthy();
      expect(screen.getByText(/Use df -h para ver o disco/)).toBeTruthy();
      expect(screen.getByText("Mensagem aprovada.")).toBeTruthy();
    });

    // Clicar em "Nova conversa" limpa o histórico e não restaura ao remontar
    await user.click(screen.getByRole("button", { name: /Nova conversa/ }));
    expect(screen.queryByText(/Use df -h para ver o disco/)).toBeNull();
  });
});
