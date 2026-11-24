import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "./engine";
import { MiniOffice } from "./MiniOffice";
import { clampWidth, MINI_WIDTH, setMiniMode, setMiniWidth } from "./mini";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((message: MessageEvent<string>) => void)[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(event: AgentEvent) {
    for (const listener of this.listeners.get("agent_event") ?? []) {
      listener({ data: JSON.stringify(event) } as MessageEvent<string>);
    }
  }
}

function event(room: string, action: string, order: number, summary = "passo"): AgentEvent {
  return {
    id: `id-${order}`,
    conversation_id: "conversa-1",
    ticket_id: null,
    room,
    action,
    summary,
    agent_name: "Agente",
    metadata: {},
    created_at: new Date(Date.UTC(2026, 10, 6, 14, 0, order)).toISOString(),
  };
}

function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const { pathname } = new URL(request.url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (pathname === "/api/escritorio/atendimentos") return json([]);
      if (pathname === "/api/escritorio/eventos") return json([]);
      return new Response("{}", { status: 404 });
    }),
  );
}

function renderMini(onOpenFull = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MiniOffice onOpenFull={onOpenFull} />
    </QueryClientProvider>,
  );
  return onOpenFull;
}

beforeEach(() => {
  localStorage.clear();
  setMiniMode("open");
  setMiniWidth(MINI_WIDTH.default);
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MiniOffice", () => {
  it("começa minimizado quando não há preferência salva", () => {
    renderMini();
    act(() => {
      localStorage.removeItem("h2d-escritorio-mini");
      window.dispatchEvent(new StorageEvent("storage", { key: "h2d-escritorio-mini" }));
    });

    expect(screen.queryByRole("region", { name: "Mini-escritório" })).toBeNull();
    expect(screen.getByRole("button", { name: /Abrir o mini-escritório/ })).toBeTruthy();
  });

  it("aberto, mostra a cena parada e a dica enquanto não há atividade", async () => {
    renderMini();

    expect(screen.getByRole("region", { name: "Mini-escritório" })).toBeTruthy();
    expect(screen.getByTestId("office-scene").getAttribute("data-active-room")).toBe("");
    expect(screen.getByText(/Aguardando atividade/)).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  });

  it("acompanha ao vivo: um evento novo acende a sala e mostra o resumo", async () => {
    renderMini();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0]!.emit(
        event("triagem", "classificado", 1, "Categoria VPN · prioridade P2"),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("office-scene").getAttribute("data-active-room")).toBe("triagem"),
    );
    expect(screen.getByText(/Triagem: Categoria VPN · prioridade P2/)).toBeTruthy();
    expect(screen.getByText("1/1")).toBeTruthy();
  });

  it("minimizar vira só um botão, e clicar nele abre de novo", async () => {
    const user = userEvent.setup();
    renderMini();

    await user.click(screen.getByRole("button", { name: "Minimizar o mini-escritório" }));
    expect(screen.queryByRole("region", { name: "Mini-escritório" })).toBeNull();
    expect(localStorage.getItem("h2d-escritorio-mini")).toBe("min");

    await user.click(screen.getByRole("button", { name: /Abrir o mini-escritório/ }));
    expect(screen.getByRole("region", { name: "Mini-escritório" })).toBeTruthy();
    expect(localStorage.getItem("h2d-escritorio-mini")).toBe("open");
  });

  it("ocultar some de vez, guarda a escolha e fecha a conexão ao vivo", async () => {
    const user = userEvent.setup();
    renderMini();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Ocultar o mini-escritório" }));

    expect(screen.queryByRole("region", { name: "Mini-escritório" })).toBeNull();
    expect(screen.queryByRole("button", { name: /mini-escritório/i })).toBeNull();
    expect(localStorage.getItem("h2d-escritorio-mini")).toBe("off");
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it("já oculto, não renderiza nada e nem abre conexão", () => {
    setMiniMode("off");
    renderMini();

    expect(screen.queryByRole("region", { name: "Mini-escritório" })).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("o botão de abrir completo chama o escritório inteiro", async () => {
    const user = userEvent.setup();
    const onOpenFull = renderMini();

    await user.click(screen.getByRole("button", { name: "Abrir o escritório completo" }));

    expect(onOpenFull).toHaveBeenCalledTimes(1);
  });

  describe("tamanho ajustável", () => {
    const widthOf = () =>
      (screen.getByRole("region", { name: "Mini-escritório" }) as HTMLElement).style.width;

    it("começa no tamanho padrão e tem o limite da largura da tela", () => {
      renderMini();

      expect(widthOf()).toBe(`${MINI_WIDTH.default}px`);
      const handle = screen.getByRole("slider", { name: "Tamanho do mini-escritório" });
      expect(handle.getAttribute("aria-valuenow")).toBe(String(MINI_WIDTH.default));
      expect(handle.getAttribute("aria-valuemin")).toBe(String(MINI_WIDTH.min));
      expect(handle.getAttribute("aria-valuemax")).toBe(String(MINI_WIDTH.max));
    });

    it("as setas aumentam e diminuem, e a escolha fica guardada", async () => {
      const user = userEvent.setup();
      renderMini();
      const handle = screen.getByRole("slider", { name: "Tamanho do mini-escritório" });
      handle.focus();

      await user.keyboard("{ArrowLeft}{ArrowLeft}");
      expect(widthOf()).toBe(`${MINI_WIDTH.default + 64}px`);
      expect(localStorage.getItem("h2d-escritorio-mini-width")).toBe(
        String(MINI_WIDTH.default + 64),
      );

      await user.keyboard("{ArrowRight}");
      expect(widthOf()).toBe(`${MINI_WIDTH.default + 32}px`);
    });

    it("nunca passa dos limites, nem pelo teclado", async () => {
      const user = userEvent.setup();
      renderMini();
      const handle = screen.getByRole("slider", { name: "Tamanho do mini-escritório" });
      handle.focus();

      await user.keyboard("{End}{ArrowLeft}");
      expect(handle.getAttribute("aria-valuenow")).toBe(String(MINI_WIDTH.max));
      await user.keyboard("{Home}{ArrowRight}");
      expect(handle.getAttribute("aria-valuenow")).toBe(String(MINI_WIDTH.min));
    });

    it("clique duplo volta ao tamanho padrão", async () => {
      const user = userEvent.setup();
      renderMini();
      const handle = screen.getByRole("slider", { name: "Tamanho do mini-escritório" });
      handle.focus();
      await user.keyboard("{End}");
      expect(handle.getAttribute("aria-valuenow")).toBe(String(MINI_WIDTH.max));

      await user.dblClick(handle);

      expect(handle.getAttribute("aria-valuenow")).toBe(String(MINI_WIDTH.default));
    });

    it("largura guardada inválida ou fora do limite é corrigida", () => {
      expect(clampWidth(5)).toBe(MINI_WIDTH.min);
      expect(clampWidth(99999)).toBe(MINI_WIDTH.max);
      expect(clampWidth(Number.NaN)).toBe(MINI_WIDTH.default);
      expect(clampWidth(400.6)).toBe(401);
    });
  });
});
