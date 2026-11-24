import { ChevronDown, X } from "lucide-react";
import { Dialog as RadixDialog, Switch as RadixSwitch, Tabs as RadixTabs } from "radix-ui";
import type { ComponentProps, HTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

import { cn, initials } from "@/lib/utils";

import type { Tone } from "./badge";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border border-border bg-surface shadow-card", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

const BAR_TONES: Record<Tone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent",
  info: "bg-info",
  warn: "bg-warn",
  danger: "bg-danger",
};

export function Progress({
  value,
  tone = "accent",
  label,
  className,
}: {
  value: number;
  tone?: Tone;
  label: string;
  className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
    >
      <div
        className={cn("chart-bar-h h-full rounded-full", BAR_TONES[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-2", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
      {children}
    </kbd>
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn("relative", className)}>
      <select
        className="h-10 w-full cursor-pointer appearance-none rounded-lg border border-border bg-surface pr-9 pl-3 text-sm text-text hover:border-muted"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted"
      />
    </div>
  );
}

export function Switch({ label, ...props }: ComponentProps<typeof RadixSwitch.Root> & { label: string }) {
  return (
    <RadixSwitch.Root
      aria-label={label}
      className="relative h-6 w-10 shrink-0 cursor-pointer rounded-full bg-border transition-colors data-[state=checked]:bg-accent"
      {...props}
    >
      <RadixSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-card transition-transform data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  );
}

export function Tabs({
  tabs,
  value,
  defaultValue,
  onValueChange,
  label,
}: {
  tabs: { value: string; label: string; count?: number; content?: ReactNode }[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  label: string;
}) {
  return (
    <RadixTabs.Root
      value={value}
      defaultValue={defaultValue ?? tabs[0]?.value}
      onValueChange={onValueChange}
    >
      <RadixTabs.List
        aria-label={label}
        className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border"
      >
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            className="-mb-px flex h-10 cursor-pointer items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-muted hover:text-text data-[state=active]:border-accent data-[state=active]:text-text"
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">
                {tab.count}
              </span>
            )}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map(
        (tab) =>
          tab.content !== undefined && (
            <RadixTabs.Content key={tab.value} value={tab.value} className="pt-4">
              {tab.content}
            </RadixTabs.Content>
          ),
      )}
    </RadixTabs.Root>
  );
}

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

function OverlayHeader({ title, description }: Pick<OverlayProps, "title" | "description">) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0 wrap-anywhere">
        <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
        <RadixDialog.Description className={description ? "text-sm text-muted" : "sr-only"}>
          {description ?? "Detalhes"}
        </RadixDialog.Description>
      </div>
      <RadixDialog.Close
        aria-label="Fechar"
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
      >
        <X aria-hidden className="size-[18px]" />
      </RadixDialog.Close>
    </div>
  );
}

const OVERLAY_BACKDROP = "fixed inset-0 z-40 bg-black/50";

export function Modal({ open, onOpenChange, title, description, children, footer }: OverlayProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_BACKDROP} />
        <RadixDialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-card">
          <OverlayHeader title={title} description={description} />
          <div className="overflow-y-auto p-5">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function Drawer({ open, onOpenChange, title, description, children, footer }: OverlayProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_BACKDROP} />
        <RadixDialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-surface shadow-card">
          <OverlayHeader title={title} description={description} />
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Timeline({
  items,
}: {
  items: { id: string; title: string; detail?: string; time: string; tone?: Tone }[];
}) {
  return (
    <ol className="space-y-4">
      {items.map((item, index) => (
        <li key={item.id} className="relative flex gap-3">
          {index < items.length - 1 && (
            <span aria-hidden className="absolute top-3 bottom-[-1rem] left-[5px] w-px bg-border" />
          )}
          <span
            aria-hidden
            className={cn(
              "relative mt-1.5 size-[11px] shrink-0 rounded-full ring-2 ring-surface",
              BAR_TONES[item.tone ?? "neutral"],
            )}
          />
          <div className="min-w-0">
            <p className="font-medium">{item.title}</p>
            {item.detail && <p className="text-muted">{item.detail}</p>}
            <p className="text-xs text-muted">{item.time}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
