import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/lib/api/client";
import { createAppRouter } from "@/router";

const BASE_USER: Omit<User, "role"> = {
  id: "0190a000-0000-7000-8000-000000000000",
  name: "Pessoa",
  email: "pessoa@h2d.local",
  department: null,
};

/** API falsa em memória: a sessão começa como `session` e muda com login e logout. */
function mockApi(initial: User | null, loginStatus = 200, loginUser?: User) {
  let session = initial;
  const fetchMock = vi.fn(async (request: Request) => {
    const { pathname } = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (pathname === "/api/auth/me") {
      return session ? json(session) : json({ detail: "Não autenticado" }, 401);
    }
    if (pathname === "/api/auth/login") {
      if (loginStatus !== 200) return json({ detail: "falhou" }, loginStatus);
      session = loginUser ?? null;
      return json(session);
    }
    if (pathname === "/api/auth/logout") {
      session = null;
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/health") return json({ status: "ok", version: "0.1.0" });
    return json({ detail: "não encontrado" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await router.load();
  return router;
}

const asRole = (role: User["role"]): User => ({ ...BASE_USER, role });

beforeEach(() => {
  localStorage.clear();
  // O jsdom não implementa scrollTo, que o roteador chama a cada navegação.
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("proteção de rotas", () => {
  it("sem sessão, leva ao login guardando o destino", async () => {
    mockApi(null);
    const router = await renderAt("/chat");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ redirect: "/chat" });
    expect(await screen.findByLabelText("Senha")).toBeTruthy();
  });

  it("usuário comum não abre tela de admin nem de técnico", async () => {
    mockApi(asRole("user"));
    const router = await renderAt("/admin/ingestao");
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    cleanup();

    const second = await renderAt("/chamados");
    await waitFor(() => expect(second.state.location.pathname).toBe("/chat"));
  });

  it("admin abre a tela de ingestão", async () => {
    mockApi(asRole("admin"));
    const router = await renderAt("/admin/ingestao");

    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/ingestao"));
    expect(await screen.findByRole("heading", { name: "Documentos" })).toBeTruthy();
  });

  it.each([
    ["user", "/chat"],
    ["tech", "/chamados"],
    ["admin", "/dashboard"],
  ] as const)("a raiz leva %s para %s", async (role, home) => {
    mockApi(asRole(role));
    const router = await renderAt("/");

    await waitFor(() => expect(router.state.location.pathname).toBe(home));
  });

  it("com sessão ativa, /login vai para a tela inicial", async () => {
    mockApi(asRole("tech"));
    const router = await renderAt("/login");

    await waitFor(() => expect(router.state.location.pathname).toBe("/chamados"));
  });

  it("ignora redirect para fora do app", async () => {
    mockApi(asRole("user"));
    const router = await renderAt("/login?redirect=//evil.example");

    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
  });
});

describe("menu móvel", () => {
  function mockDesktopViewport() {
    const viewport = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", vi.fn(() => viewport));
    return viewport;
  }

  it("fecha pelo botão interno e devolve o foco ao botão que abriu o menu", async () => {
    mockApi(asRole("user"));
    mockDesktopViewport();
    await renderAt("/chat");
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "Abrir menu" });

    await user.click(trigger);
    const menu = screen.getByRole("dialog", { name: "Menu" });
    await user.click(within(menu).getByRole("button", { name: "Fechar menu" }));

    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("fecha ao passar para o layout de desktop e não reabre ao voltar para o móvel", async () => {
    mockApi(asRole("user"));
    const viewport = mockDesktopViewport();
    await renderAt("/chat");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Abrir menu" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy();

    act(() => {
      viewport.matches = true;
      viewport.dispatchEvent(new Event("change"));
    });
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recolher menu" })).toBeTruthy();

    act(() => {
      viewport.matches = false;
      viewport.dispatchEvent(new Event("change"));
    });
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });
});

describe("login", () => {
  async function fill(email: string, password: string) {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("E-mail"), email);
    if (password) await user.type(screen.getByLabelText("Senha"), password);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
  }

  it("entra e vai para o destino guardado", async () => {
    mockApi(null, 200, asRole("admin"));
    const router = await renderAt("/dashboard");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));

    await fill("pessoa@h2d.local", "senha");

    await waitFor(() => expect(router.state.location.pathname).toBe("/dashboard"));
    expect(await screen.findByText("Administrador")).toBeTruthy();
  });

  it("mostra erro em credencial inválida e continua no login", async () => {
    mockApi(null, 401);
    const router = await renderAt("/login");

    await fill("pessoa@h2d.local", "errada");

    expect((await screen.findByRole("alert")).textContent).toContain("E-mail ou senha inválidos");
    expect(router.state.location.pathname).toBe("/login");
  });

  it("diferencia falha do servidor de senha errada", async () => {
    mockApi(null, 500);
    await renderAt("/login");

    await fill("pessoa@h2d.local", "senha");

    expect((await screen.findByRole("alert")).textContent).toContain("Não foi possível conectar");
  });

  it("valida o formulário sem chamar a API", async () => {
    const fetchMock = mockApi(null);
    await renderAt("/login");
    fetchMock.mockClear();

    await fill("nao-e-email", "");

    expect(await screen.findByText("Informe um e-mail válido")).toBeTruthy();
    expect(screen.getByText("Informe a senha")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sair encerra a sessão e volta ao login", async () => {
    mockApi(asRole("user"));
    const router = await renderAt("/chat");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Sair" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(await screen.findByLabelText("Senha")).toBeTruthy();
  });
});
