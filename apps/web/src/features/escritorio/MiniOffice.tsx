import { useQuery } from "@tanstack/react-query";
import { Building2, EyeOff, Maximize2, Minus, MoveDiagonal2, RotateCcw } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import {
  atendimentosQuery,
  eventosQuery,
  type AttendanceRef,
} from "./api";
import {
  type AgentEvent,
  attendanceKey,
  isRoomKey,
  mergeEvents,
  ROOM_BY_KEY,
  sceneAt,
} from "./engine";
import { useEventStream, useTimeline } from "./hooks";
import { MINI_WIDTH, type MiniMode, useMiniMode, useMiniWidth } from "./mini";
import { OfficeScene } from "./Scene";

const KEY_STEP = 32;

/**
 * Alça no canto superior esquerdo (o widget fica preso embaixo à direita, então crescer é
 * puxar para cima e para a esquerda). Funciona com mouse, toque e teclado (setas), e um clique
 * duplo volta ao tamanho padrão.
 */
function ResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number, persist?: boolean) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthAt = (event: PointerEvent) =>
    drag.current ? drag.current.startWidth + (drag.current.startX - event.clientX) : width;

  function finish(event: PointerEvent) {
    if (!drag.current) return;
    onResize(widthAt(event), true);
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent) {
    const grow = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const shrink = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (grow || shrink) onResize(width + (grow ? KEY_STEP : -KEY_STEP));
    else if (event.key === "Home") onResize(MINI_WIDTH.min);
    else if (event.key === "End") onResize(MINI_WIDTH.max);
    else if (event.key === "Escape") onResize(MINI_WIDTH.default);
    else return;
    event.preventDefault();
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Tamanho do mini-escritório"
      aria-orientation="horizontal"
      aria-valuemin={MINI_WIDTH.min}
      aria-valuemax={MINI_WIDTH.max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels de largura`}
      title="Arraste para redimensionar. Clique duas vezes para voltar ao tamanho padrão."
      onPointerDown={(event) => {
        event.preventDefault();
        drag.current = { startX: event.clientX, startWidth: width };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current) onResize(widthAt(event), false);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => onResize(MINI_WIDTH.default)}
      onKeyDown={onKeyDown}
      className="absolute top-0 left-0 z-10 flex size-7 cursor-nwse-resize touch-none items-center justify-center rounded-br-lg text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      <MoveDiagonal2 aria-hidden className="size-3.5" />
    </div>
  );
}

interface Followed {
  key: string;
  ref: AttendanceRef;
}

/** Botão pequeno e discreto dos cabeçalhos do widget. */
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}

/**
 * Mini-escritório flutuante: acompanha ao vivo o atendimento mais recente em qualquer tela, para
 * ver o caminho do fluxo sem sair do que se está fazendo. Mostra o último atendimento mesmo depois
 * de concluído (o botão de rever repete a animação). Pode ser minimizado ou ocultado.
 */
export function MiniOffice({ onOpenFull }: { onOpenFull: () => void }) {
  const [mode, setMode] = useMiniMode();
  const [width, setWidth] = useMiniWidth();
  const active = mode !== "off";

  const [pushed, setPushed] = useState<Record<string, AgentEvent[]>>({});
  const [followed, setFollowed] = useState<Followed | null>(null);

  const connection = useEventStream(active, (event) => {
    const key = attendanceKey(event);
    if (!key) return;
    setPushed((previous) => ({ ...previous, [key]: mergeEvents(previous[key] ?? [], [event]) }));
    // O atendimento que mexeu por último passa a ser o acompanhado.
    setFollowed((current) =>
      current?.key === key
        ? current
        : { key, ref: { conversationId: event.conversation_id, ticketId: event.ticket_id } },
    );
  });

  // Ao abrir a tela, mostra o atendimento mais recente (para ver como o último fluxo terminou).
  const latest = useQuery({ ...atendimentosQuery(false), enabled: active, staleTime: 30_000 });
  const fallback = latest.data?.[0];
  const key = followed?.key ?? fallback?.key ?? null;
  const ref: AttendanceRef | null =
    followed?.ref ??
    (fallback
      ? { conversationId: fallback.conversation_id, ticketId: fallback.ticket_id }
      : null);

  const history = useQuery({ ...eventosQuery(ref), enabled: active && ref !== null });
  const events = useMemo(
    () => mergeEvents(history.data ?? [], key ? (pushed[key] ?? []) : []),
    [history.data, pushed, key],
  );
  const timeline = useTimeline(events.length, key ?? "nenhum", true);
  const state = useMemo(() => sceneAt(events, timeline.index), [events, timeline.index]);

  if (!active) return null;

  const roomName = state.active ? ROOM_BY_KEY[state.active].name : null;
  const current = state.event;
  const caption = current
    ? `${isRoomKey(current.room) ? ROOM_BY_KEY[current.room].name : current.room}: ${current.summary}`
    : connection === "open" || connection === "connecting"
      ? "Aguardando atividade. Quando você falar com o assistente, o caminho aparece aqui."
      : "Reconectando ao tempo real…";

  if (mode === "min") {
    return (
      <button
        type="button"
        onClick={() => setMode("open")}
        aria-label={`Abrir o mini-escritório${roomName ? `. Sala ativa: ${roomName}` : ""}`}
        className="fixed right-4 bottom-4 z-40 hidden h-10 cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-sm font-medium shadow-lg hover:bg-surface-2 md:inline-flex"
      >
        <Building2 aria-hidden className="size-4" />
        Escritório
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            connection === "open" ? "bg-accent" : "bg-muted",
            roomName && "animate-pulse",
          )}
        />
        {roomName && <span className="hidden text-xs text-muted sm:inline">{roomName}</span>}
      </button>
    );
  }

  return (
    <section
      aria-label="Mini-escritório"
      style={{ width: `${width}px` }}
      className="fixed right-4 bottom-4 z-40 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-lg max-md:hidden"
    >
      <ResizeHandle width={width} onResize={setWidth} />
      <header className="flex items-center justify-between gap-2 border-b border-border py-1.5 pr-3 pl-9">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Building2 aria-hidden className="size-4 shrink-0" />
          <span className="truncate">Escritório</span>
          <span
            role="status"
            className={cn(
              "inline-flex items-center gap-1 text-xs font-normal",
              connection === "open" ? "text-accent" : "text-muted",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                connection === "open" ? "bg-accent" : "bg-muted",
              )}
            />
            {connection === "open"
              ? "ao vivo"
              : connection === "unsupported"
                ? "sem tempo real"
                : "reconectando"}
          </span>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton label="Rever o atendimento" onClick={timeline.restart}>
            <RotateCcw aria-hidden className="size-3.5" />
          </IconButton>
          <IconButton label="Abrir o escritório completo" onClick={onOpenFull}>
            <Maximize2 aria-hidden className="size-3.5" />
          </IconButton>
          <IconButton label="Minimizar o mini-escritório" onClick={() => setMode("min")}>
            <Minus aria-hidden className="size-3.5" />
          </IconButton>
          <IconButton label="Ocultar o mini-escritório" onClick={() => setMode("off")}>
            <EyeOff aria-hidden className="size-3.5" />
          </IconButton>
        </div>
      </header>
      <OfficeScene state={state} />
      <p
        role="status"
        aria-live="polite"
        className="flex items-start justify-between gap-3 px-3 py-2 text-xs text-muted"
      >
        <span className="min-w-0 break-words">{caption}</span>
        {state.total > 0 && (
          <span className="shrink-0 font-mono">
            {Math.max(state.index + 1, 0)}/{state.total}
          </span>
        )}
      </p>
    </section>
  );
}

export type { MiniMode };
