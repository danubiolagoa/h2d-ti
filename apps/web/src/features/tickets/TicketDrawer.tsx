import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MessageSquare, Pause, Play, UserRoundPlus } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Drawer, Field, Select, Timeline } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { meQuery } from "@/lib/auth";

import {
  commentTicket,
  resolveTicket,
  techniciansQuery,
  type TicketDetail,
  type TicketEvent,
  ticketQuery,
  type TicketStatus,
  updateTicket,
} from "./api";
import { formatDate, PriorityBadge, SlaBadge, STATUS_LABELS, StatusBadge } from "./badges";

const TEXTAREA =
  "w-full rounded-lg border border-border bg-surface p-3 text-sm text-text placeholder:text-muted hover:border-muted";

function eventView(event: TicketEvent): { title: string; detail?: string; tone?: "accent" | "info" | "warn" | "neutral" } {
  const who = event.actor_name ?? "Sistema";
  switch (event.type) {
    case "created":
      return { title: "Chamado criado", detail: event.actor_name ? `por ${who}` : undefined, tone: "info" };
    case "classified":
      return { title: "Classificado pelo assistente", detail: event.reason ?? undefined, tone: "info" };
    case "assigned":
      return { title: "Atribuído a um técnico", detail: event.reason ?? undefined, tone: "accent" };
    case "triage":
      return { title: "Enviado à triagem manual", detail: event.reason ?? undefined, tone: "warn" };
    case "escalated":
      return { title: "Conversa encaminhada à TI", detail: event.reason ?? undefined, tone: "info" };
    case "status_changed": {
      const to = String(event.payload.to ?? "") as TicketStatus;
      return { title: `Status: ${STATUS_LABELS[to] ?? to}`, detail: event.reason ?? `por ${who}`, tone: "neutral" };
    }
    case "comment":
      return { title: `${who} comentou`, detail: String(event.payload.text ?? ""), tone: "neutral" };
    case "resolved":
      return { title: "Resolvido", detail: String(event.payload.solution ?? ""), tone: "accent" };
    default:
      return { title: event.type, detail: event.reason ?? undefined };
  }
}

const short = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

export function TicketDrawer({ ticketId, onClose }: { ticketId: string | null; onClose: () => void }) {
  const ticket = useQuery({ ...ticketQuery(ticketId ?? ""), enabled: ticketId !== null });
  return (
    <Drawer
      open={ticketId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={ticket.data ? `${ticket.data.code} · ${short(ticket.data.summary)}` : "Chamado"}
      description={ticket.data ? `Aberto por ${ticket.data.requester_name}` : undefined}
    >
      {ticket.isPending && ticketId !== null && <p className="text-muted">Carregando…</p>}
      {ticket.isError && (
        <p role="alert" className="text-danger">
          Não foi possível abrir este chamado.
        </p>
      )}
      {ticket.data && <Detail ticket={ticket.data} />}
    </Drawer>
  );
}

function Detail({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const isStaff = me?.role === "tech" || me?.role === "admin";
  const isAdmin = me?.role === "admin";
  const closed = ticket.status === "resolved";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["tickets"] });
  };

  async function changeStatus(status: TicketStatus) {
    setBusy(true);
    setError(null);
    const result = await updateTicket(ticket.id, { status });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    toast(`Status: ${STATUS_LABELS[status]}`, ticket.code);
    await refresh();
  }

  async function reassign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const technicianId = String(form.get("technician") ?? "");
    if (!technicianId) return;
    setBusy(true);
    setError(null);
    const result = await updateTicket(ticket.id, {
      technician_id: technicianId,
      reason: String(form.get("reason") ?? "") || undefined,
    });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    toast("Chamado atribuído", ticket.code);
    await refresh();
  }

  async function comment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get("text") ?? "").trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    const result = await commentTicket(ticket.id, text);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    form.reset();
    await refresh();
  }

  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const solution = String(new FormData(event.currentTarget).get("solution") ?? "").trim();
    setBusy(true);
    setError(null);
    const result = await resolveTicket(ticket.id, solution);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    toast("Chamado resolvido", ticket.code);
    setResolving(false);
    await refresh();
  }

  return (
    <div className="space-y-6 wrap-anywhere">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        {ticket.is_vip && <span className="text-xs font-medium text-warn">VIP</span>}
        <SlaBadge sla={ticket.sla} />
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Solicitante</dt>
          <dd>{ticket.requester_name}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Responsável</dt>
          <dd>{ticket.technician_name ?? "Ninguém ainda"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Aberto em</dt>
          <dd>{formatDate(ticket.created_at)}</dd>
        </div>
        {ticket.confidence !== null && (
          <div>
            <dt className="text-xs text-muted">Confiança da classificação</dt>
            <dd>{Math.round(ticket.confidence * 100)}%</dd>
          </div>
        )}
      </dl>

      {ticket.already_tried && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">O que já foi tentado</h3>
          <p className="whitespace-pre-wrap text-muted">{ticket.already_tried}</p>
        </section>
      )}

      {isStaff && ticket.description && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Conversa com o assistente</summary>
          <p className="border-t border-border p-3 text-sm whitespace-pre-wrap text-muted">{ticket.description}</p>
        </details>
      )}

      {ticket.solution && (
        <section className="rounded-lg bg-accent-soft p-3">
          <h3 className="mb-1 text-sm font-semibold text-accent">Solução aplicada</h3>
          <p className="whitespace-pre-wrap">{ticket.solution}</p>
        </section>
      )}

      {isStaff && !closed && (
        <section className="space-y-3 rounded-lg border border-border p-3">
          <h3 className="text-sm font-semibold">Atendimento</h3>
          <div className="flex flex-wrap gap-2">
            {ticket.status !== "in_progress" && (
              <Button disabled={busy} onClick={() => void changeStatus("in_progress")}>
                <Play aria-hidden className="size-4" />
                Iniciar atendimento
              </Button>
            )}
            {ticket.status !== "waiting_user" && (
              <Button disabled={busy} onClick={() => void changeStatus("waiting_user")}>
                <Pause aria-hidden className="size-4" />
                Aguardar usuário
              </Button>
            )}
            <Button variant="primary" disabled={busy} onClick={() => setResolving((v) => !v)}>
              <CheckCircle2 aria-hidden className="size-4" />
              Resolver
            </Button>
          </div>
          {resolving && (
            <form onSubmit={(event) => void resolve(event)} className="space-y-2">
              <Field label="Solução aplicada" htmlFor="ticket-solution" hint="Vira registro do chamado.">
                <textarea id="ticket-solution" name="solution" required minLength={3} rows={3} className={TEXTAREA} />
              </Field>
              <Button type="submit" variant="primary" disabled={busy}>
                Confirmar resolução
              </Button>
            </form>
          )}
          {isAdmin && <ReassignForm busy={busy} onSubmit={(event) => void reassign(event)} />}
        </section>
      )}

      <section>
        <h3 className="mb-3 text-sm font-semibold">Linha do tempo</h3>
        <Timeline
          items={ticket.events.map((event) => ({
            id: event.id,
            ...eventView(event),
            time: formatDate(event.created_at),
          }))}
        />
      </section>

      {!closed && (
        <form onSubmit={(event) => void comment(event)} className="space-y-2">
          <Field label="Comentar" htmlFor="ticket-comment">
            <textarea id="ticket-comment" name="text" required rows={2} maxLength={4000} className={TEXTAREA} />
          </Field>
          <Button type="submit" disabled={busy}>
            <MessageSquare aria-hidden className="size-4" />
            Enviar comentário
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ReassignForm({ busy, onSubmit }: { busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const technicians = useQuery(techniciansQuery);
  return (
    <form onSubmit={onSubmit} className="space-y-2 border-t border-border pt-3">
      <Field label="Atribuir a" htmlFor="ticket-technician">
        <Select id="ticket-technician" name="technician" defaultValue="">
          <option value="" disabled>
            Escolha um técnico
          </option>
          {(technicians.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.open_tickets} abertos{t.is_available ? "" : " · ausente"}
            </option>
          ))}
        </Select>
      </Field>
      <input
        name="reason"
        maxLength={500}
        placeholder="Motivo (opcional)"
        aria-label="Motivo da atribuição"
        className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm placeholder:text-muted hover:border-muted"
      />
      <Button type="submit" disabled={busy}>
        <UserRoundPlus aria-hidden className="size-4" />
        Atribuir
      </Button>
    </form>
  );
}
