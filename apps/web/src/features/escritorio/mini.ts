import { useSyncExternalStore } from "react";

/** Como o mini-escritório aparece nas outras telas: aberto, minimizado (só um botão) ou oculto. */
export type MiniMode = "open" | "min" | "off";

/** Largura do mini-escritório, em pixels. A altura acompanha (a cena é SVG e escala sozinha). */
export const MINI_WIDTH = { min: 288, max: 960, default: 416 } as const;

const MODE_KEY = "h2d-escritorio-mini";
const WIDTH_KEY = "h2d-escritorio-mini-width";
const listeners = new Set<() => void>();

// Se o armazenamento do navegador estiver bloqueado, a escolha vale em memória até recarregar.
let modeMemory: MiniMode | null = null;
let widthMemory: number | null = null;

function readMode(): MiniMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === "open" || value === "off" ? value : "min";
  } catch {
    return "min";
  }
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return MINI_WIDTH.default;
  return Math.round(Math.min(Math.max(width, MINI_WIDTH.min), MINI_WIDTH.max));
}

function readWidth(): number {
  try {
    const stored = localStorage.getItem(WIDTH_KEY);
    return stored === null ? MINI_WIDTH.default : clampWidth(Number(stored));
  } catch {
    return MINI_WIDTH.default;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Outra aba mudou a preferência: a memória local deixa de valer.
  const onStorage = () => {
    modeMemory = null;
    widthMemory = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setMiniMode(mode: MiniMode) {
  modeMemory = mode;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // fica só em memória
  }
  notify();
}

/** `persist: false` durante o arraste (só atualiza a tela); `true` ao soltar (grava). */
export function setMiniWidth(width: number, persist = true) {
  const next = clampWidth(width);
  widthMemory = next;
  if (persist) {
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // fica só em memória
    }
  }
  notify();
}

export function useMiniMode(): [MiniMode, (mode: MiniMode) => void] {
  const mode = useSyncExternalStore(subscribe, () => modeMemory ?? readMode(), () => "min" as MiniMode);
  return [mode, setMiniMode];
}

export function useMiniWidth(): [number, (width: number, persist?: boolean) => void] {
  const width = useSyncExternalStore(
    subscribe,
    () => widthMemory ?? readWidth(),
    () => MINI_WIDTH.default,
  );
  return [width, setMiniWidth];
}
