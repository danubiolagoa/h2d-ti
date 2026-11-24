import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { Bell, ChevronRight, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import { Dialog, DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";

import { CommandPalette } from "@/components/CommandPalette";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CountBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, Kbd } from "@/components/ui/primitives";
import { Toaster } from "@/components/ui/toast";
import { api, type Role, type User } from "@/lib/api/client";
import { logout } from "@/lib/auth";
import { useEscritorioEnabled } from "@/features/escritorio/api";
import { MiniOffice } from "@/features/escritorio/MiniOffice";
import { type Ticket, ticketsQuery } from "@/features/tickets/api";
import { NAV_ITEMS, navGroupsFor } from "@/lib/navigation";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<Role, string> = {
  user: "Usuário",
  tech: "Técnico de TI",
  admin: "Administrador",
};

const COLLAPSED_KEY = "h2d-sidebar-collapsed";

const systemStatusQuery = {
  queryKey: ["system-status"],
  refetchInterval: 30_000,
  retry: false,
  queryFn: async () => {
    const { data } = await api.GET("/api/status");
    if (!data) throw new Error("API indisponível");
    return data;
  },
};

/** Chamados da equipe: alimentam o contador do menu e os avisos. Só técnico e admin os consultam. */
function useOpenTickets(enabled: boolean): Ticket[] {
  const { data } = useQuery({ ...ticketsQuery(), enabled, refetchInterval: 60_000 });
  return (data ?? []).filter((ticket) => ticket.status !== "resolved");
}

type Notice = { id: string; title: string; detail: string; urgent: boolean };

/** Avisos tirados dos chamados reais: prazo estourado, prazo em risco e triagem manual. */
function noticesFrom(tickets: Ticket[]): Notice[] {
  const notices: Notice[] = [];
  for (const ticket of tickets) {
    if (ticket.sla.state === "breached") {
      notices.push({ id: `${ticket.id}-b`, title: "SLA estourado", detail: `${ticket.code}: ${ticket.summary}`, urgent: true });
    } else if (ticket.sla.state === "at_risk") {
      notices.push({ id: `${ticket.id}-r`, title: "SLA em risco", detail: `${ticket.code}: ${ticket.summary}`, urgent: true });
    }
    if (ticket.status === "triage") {
      notices.push({ id: `${ticket.id}-t`, title: "Triagem manual", detail: `${ticket.code} precisa de classificação`, urgent: false });
    }
  }
  return notices.sort((a, b) => Number(b.urgent) - Number(a.urgent)).slice(0, 8);
}

function SidebarNav({
  role,
  collapsed,
  onNavigate,
}: {
  role: Role;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const open = useOpenTickets(role !== "user");
  const escritorio = useEscritorioEnabled();
  const counts: Record<string, number> = { "/chamados": open.length };
  return (
    <nav aria-label="Módulos" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {navGroupsFor(role, { escritorio }).map((group) => (
        <div key={group.name}>
          {!collapsed && (
            <p className="mb-1.5 px-3 text-xs font-medium text-sidebar-muted">{group.name}</p>
          )}
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.path}>
                <Link
                  to={item.path}
                  title={collapsed ? item.title : undefined}
                  aria-label={collapsed ? item.title : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "flex h-10 items-center gap-3 rounded-lg px-3 transition-colors",
                    collapsed && "justify-center px-0",
                  )}
                  inactiveProps={{ className: "hover:bg-sidebar-hover hover:text-white" }}
                  // A barra verde e o peso garantem que o estado não dependa só da cor.
                  activeProps={{
                    className:
                      "bg-sidebar-hover font-medium text-white shadow-[inset_3px_0_0_var(--sidebar-accent)]",
                    "aria-current": "page",
                  }}
                >
                  <item.icon aria-hidden className="size-[18px] shrink-0" />
                  {!collapsed && <span className="min-w-0 flex-1 truncate">{item.title}</span>}
                  {!collapsed && counts[item.path] ? (
                    <CountBadge count={counts[item.path]!} />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Sidebar({ role }: { role: Role }) {
  const status = useQuery(systemStatusQuery);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "true");

  function toggle() {
    localStorage.setItem(COLLAPSED_KEY, String(!collapsed));
    setCollapsed(!collapsed);
  }

  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = collapsed ? "Expandir menu" : "Recolher menu";

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col bg-sidebar text-sidebar-text transition-[width] lg:flex",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className={cn("flex h-16 items-center text-white", collapsed ? "justify-center" : "px-5")}>
        <Logo subtitle iconOnly={collapsed} />
      </div>
      <SidebarNav role={role} collapsed={collapsed} />
      <div
        className={cn(
          "flex items-center border-t border-white/10 p-2 text-xs text-sidebar-muted",
          collapsed ? "justify-center" : "justify-between pl-5",
        )}
      >
        {!collapsed && <span>{status.data ? `Versão ${status.data.version}` : ""}</span>}
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={toggle}
          className="flex size-9 cursor-pointer items-center justify-center rounded-lg hover:bg-sidebar-hover hover:text-white"
        >
          <Icon aria-hidden className="size-[18px]" />
        </button>
      </div>
    </aside>
  );
}

function MobileMenu({ role }: { role: Role }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Mesmo breakpoint lg que exibe a barra lateral e oculta o botão móvel.
    const desktop = window.matchMedia("(min-width: 64rem)");
    function closeOnDesktop() {
      if (desktop.matches) setOpen(false);
    }
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button aria-label="Abrir menu" className="size-10 shrink-0 px-0 lg:hidden">
          <Menu aria-hidden className="size-5" />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-text">
          <Dialog.Title className="sr-only">Menu</Dialog.Title>
          <Dialog.Description className="sr-only">Módulos do sistema</Dialog.Description>
          <div className="flex h-16 shrink-0 items-center justify-between gap-2 pl-5 pr-3 text-white">
            <Logo subtitle />
            <Dialog.Close asChild>
              <Button
                aria-label="Fechar menu"
                className="size-11 shrink-0 px-0 text-sidebar-text hover:bg-sidebar-hover hover:text-white focus-visible:outline-sidebar-accent"
              >
                <X aria-hidden className="size-5" />
              </Button>
            </Dialog.Close>
          </div>
          <SidebarNav role={role} onNavigate={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type IndicatorState = "ok" | "degraded" | "unavailable" | "unknown";

const DOT_BY_STATE: Record<IndicatorState, string> = {
  ok: "bg-accent",
  degraded: "bg-warn",
  unavailable: "bg-danger",
  unknown: "bg-muted",
};

export function ApiStatus() {
  const status = useQuery(systemStatusQuery);

  const services: Array<{
    key: string;
    shortLabel: string;
    label: string;
    state: IndicatorState;
    detail: string;
    latencyMs?: number | null;
  }> = status.data
    ? [
        {
          key: "backend",
          shortLabel: "Backend",
          label: "Backend (API)",
          state: status.data.backend.status,
          detail: status.data.backend.detail,
          latencyMs: status.data.backend.latency_ms,
        },
        {
          key: "database",
          shortLabel: "Banco",
          label: "Banco de Dados",
          state: status.data.database.status,
          detail: status.data.database.detail,
          latencyMs: status.data.database.latency_ms,
        },
        {
          key: "openrouter",
          shortLabel: "IA",
          label: "Modelo de IA",
          state: status.data.openrouter.status,
          detail: status.data.openrouter.detail,
          latencyMs: status.data.openrouter.latency_ms,
        },
      ]
    : status.isError
      ? [
          {
            key: "backend",
            shortLabel: "Backend",
            label: "Backend (API)",
            state: "unavailable",
            detail: "Sem conexão",
          },
          {
            key: "database",
            shortLabel: "Banco",
            label: "Banco de Dados",
            state: "unknown",
            detail: "Não verificado",
          },
          {
            key: "openrouter",
            shortLabel: "IA",
            label: "Modelo de IA",
            state: "unknown",
            detail: "Não verificado",
          },
        ]
      : [
          {
            key: "backend",
            shortLabel: "Backend",
            label: "Backend (API)",
            state: "unknown",
            detail: "Verificando...",
          },
          {
            key: "database",
            shortLabel: "Banco",
            label: "Banco de Dados",
            state: "unknown",
            detail: "Verificando...",
          },
          {
            key: "openrouter",
            shortLabel: "IA",
            label: "Modelo de IA",
            state: "unknown",
            detail: "Verificando...",
          },
        ];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          role="status"
          aria-label="Status dos serviços"
          title={services.map((s) => `${s.label}: ${s.detail}`).join(" • ")}
          className="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-bg px-2.5 text-xs text-muted transition-colors hover:border-muted hover:text-text"
        >
          {services.map((service) => (
            <span key={service.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden className={cn("size-2 rounded-full", DOT_BY_STATE[service.state])} />
              <span>{service.shortLabel}</span>
            </span>
          ))}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-30 w-64 rounded-xl border border-border bg-surface p-1.5 shadow-card"
        >
          <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-semibold text-text">
            Status dos serviços
          </DropdownMenu.Label>
          <div className="space-y-1">
            {services.map((service) => (
              <div
                key={service.key}
                className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-xs"
              >
                <span className="flex items-center gap-2 font-medium text-text">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_BY_STATE[service.state])} />
                  {service.label}
                </span>
                <span className="text-right text-muted">
                  {service.detail}
                  {service.latencyMs != null ? ` · ${service.latencyMs} ms` : ""}
                </span>
              </div>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Breadcrumb() {
  const { pathname } = useLocation();
  const current = NAV_ITEMS.find((item) => item.path === pathname);
  if (!current) return null;

  return (
    <nav aria-label="Você está em" className="hidden items-center gap-1.5 text-sm md:flex">
      <span className="text-muted">{current.group}</span>
      <ChevronRight aria-hidden className="size-4 text-muted" />
      <span className="font-medium">{current.title}</span>
    </nav>
  );
}

function Notifications() {
  const notices = noticesFrom(useOpenTickets(true));
  const urgent = notices.filter((item) => item.urgent).length;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button aria-label={`Notificações: ${urgent} urgentes`} className="relative size-10 px-0">
          <Bell aria-hidden className="size-[18px]" />
          <CountBadge count={urgent} className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 text-[10px]" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-30 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          <DropdownMenu.Label className="px-3 py-2 font-semibold">Notificações</DropdownMenu.Label>
          {notices.length === 0 && (
            <p className="px-3 py-4 text-muted">Nada pedindo atenção agora.</p>
          )}
          {notices.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              className="flex cursor-pointer gap-3 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-surface-2"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  item.urgent ? "bg-danger" : "bg-muted",
                )}
              />
              <span className="min-w-0">
                <span className="block font-medium">{item.title}</span>
                <span className="block text-muted">{item.detail}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AppShell({ user }: { user: User }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const escritorioEnabled = useEscritorioEnabled();
  const queryClient = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleLogout() {
    await logout(queryClient);
    await navigate({ to: "/login" });
  }

  return (
    <div className="flex h-dvh">
      <Sidebar role={user.role} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <MobileMenu role={user.role} />
            <Breadcrumb />
          </div>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Buscar no sistema"
              className="flex h-10 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-muted hover:bg-surface-2 sm:border sm:border-border sm:bg-bg sm:pr-2 sm:hover:border-muted lg:w-64"
            >
              <Search aria-hidden className="size-[18px] shrink-0" />
              <span className="hidden flex-1 text-left text-sm lg:block">Buscar...</span>
              <span className="hidden sm:inline">
                <Kbd>Ctrl K</Kbd>
              </span>
            </button>
            <div className="mx-2 hidden xl:block">
              <ApiStatus />
            </div>
            {/* Os avisos são da operação de TI, não de quem abre chamados. */}
            {user.role !== "user" && <Notifications />}
            <ThemeToggle />
            <div className="ml-1 hidden items-center gap-2.5 border-l border-border pl-3 sm:flex">
              <Avatar name={user.name} className="size-9" />
              <span className="hidden leading-tight lg:block">
                <span className="block max-w-36 truncate text-sm font-medium">{user.name}</span>
                <span className="block text-xs text-muted">{ROLE_LABELS[user.role]}</span>
              </span>
            </div>
            <Button aria-label="Sair" title="Sair" className="size-10 px-0" onClick={handleLogout}>
              <LogOut aria-hidden className="size-[18px]" />
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 lg:p-6">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} role={user.role} />
      {/* Mini-escritório (experimento): só com a flag ligada e fora da tela cheia do escritório. */}
      {escritorioEnabled && pathname !== "/escritorio" && (
        <MiniOffice onOpenFull={() => void navigate({ to: "/escritorio" })} />
      )}
      <Toaster />
    </div>
  );
}
