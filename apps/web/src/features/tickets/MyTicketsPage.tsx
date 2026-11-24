import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { buttonClassName } from "@/components/ui/button";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Card } from "@/components/ui/primitives";

import { type Ticket, ticketsQuery } from "./api";
import { formatDate, PriorityBadge, SlaBadge, StatusBadge } from "./badges";
import { TicketDrawer } from "./TicketDrawer";

const COLUMNS: Column<Ticket>[] = [
  {
    key: "code",
    header: "Código",
    sortValue: (ticket) => ticket.code,
    render: (ticket) => <span className="font-mono text-xs">{ticket.code}</span>,
  },
  {
    key: "summary",
    header: "Assunto",
    sortValue: (ticket) => ticket.summary,
    render: (ticket) => <span className="font-medium">{ticket.summary}</span>,
  },
  { key: "priority", header: "Prioridade", render: (t) => <PriorityBadge priority={t.priority} /> },
  { key: "status", header: "Status", render: (t) => <StatusBadge status={t.status} /> },
  { key: "sla", header: "Prazo", render: (t) => <SlaBadge sla={t.sla} /> },
  {
    key: "updated",
    header: "Atualizado",
    sortValue: (ticket) => ticket.updated_at,
    render: (ticket) => <span className="whitespace-nowrap text-muted">{formatDate(ticket.updated_at)}</span>,
  },
];

export function MyTicketsPage() {
  const tickets = useQuery(ticketsQuery());
  const [openedId, setOpenedId] = useState<string | null>(null);
  const rows = tickets.data ?? [];

  return (
    <section>
      <PageHeader
        title="Meus chamados"
        description="Acompanhe o andamento dos chamados que você abriu."
        actions={
          <Link to="/chat" className={buttonClassName("primary")}>
            <MessageCircle aria-hidden className="size-4" />
            Abrir pelo assistente
          </Link>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        {[
          ["Em aberto", rows.filter((t) => t.status !== "resolved").length],
          ["Aguardando você", rows.filter((t) => t.status === "waiting_user").length],
          ["Resolvidos", rows.filter((t) => t.status === "resolved").length],
        ].map(([label, value]) => (
          <Card key={label} className="p-5">
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        {tickets.isError ? (
          <p role="alert" className="p-5 text-danger">
            Não foi possível carregar os chamados.
          </p>
        ) : (
          <DataTable
            label="Meus chamados"
            columns={COLUMNS}
            rows={rows}
            rowKey={(ticket) => ticket.id}
            onRowClick={(ticket) => setOpenedId(ticket.id)}
            empty="Você ainda não abriu chamados. Converse com o assistente: se ele não resolver, abre um para você."
          />
        )}
      </Card>

      <TicketDrawer ticketId={openedId} onClose={() => setOpenedId(null)} />
    </section>
  );
}
