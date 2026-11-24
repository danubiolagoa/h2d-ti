import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BadgeCheck,
  Binary,
  Bot,
  Database,
  FileText,
  FileUp,
  Loader2,
  type LucideIcon,
  Merge,
  Scissors,
  Search,
  ShieldCheck,
  Type,
} from "lucide-react";
import { type CSSProperties, type FormEvent, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Drawer, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { ragChunkQuery, ragOverviewQuery, type RagTrace, traceQuestion } from "./api";
import { formatNumber } from "./parts";
import {
  CheckStage,
  ChunkAnatomyView,
  EmbeddingStage,
  FusionStage,
  GenerationStage,
  IngestionStage,
  MaskingStage,
  PromptStage,
  SearchStage,
  TokenizationStage,
} from "./stages";

type StepKey =
  | "doc"
  | "text"
  | "chunks"
  | "embed"
  | "index"
  | "masking"
  | "tokenization"
  | "embedding"
  | "search"
  | "fusion"
  | "prompt"
  | "generation"
  | "check";

interface Step {
  key: StepKey;
  title: string;
  hint: string;
  icon: LucideIcon;
  /** Nome da etapa em `timings`, quando o rastreio mede esse passo. */
  timing?: string;
}

const INGESTION: Step[] = [
  { key: "doc", title: "Documento", hint: "PDF, DOCX, MD", icon: FileUp },
  { key: "text", title: "Texto", hint: "vira Markdown", icon: FileText },
  { key: "chunks", title: "Trechos", hint: "corte por título", icon: Scissors },
  { key: "embed", title: "Embedding", hint: "vetor por trecho", icon: Binary },
  { key: "index", title: "Índices", hint: "HNSW + GIN", icon: Database },
];

const QUERY: Step[] = [
  { key: "masking", title: "Máscara", hint: "dados sensíveis", icon: ShieldCheck, timing: "masking" },
  { key: "tokenization", title: "Tokenização", hint: "modelo e radicais", icon: Type, timing: "tokenization" },
  { key: "embedding", title: "Embedding", hint: "vetor da pergunta", icon: Binary, timing: "embedding" },
  { key: "search", title: "Busca dupla", hint: "vetor e palavras", icon: Search, timing: "search" },
  { key: "fusion", title: "Fusão RRF", hint: "soma das posições", icon: Merge, timing: "fusion" },
  { key: "prompt", title: "Prompt", hint: "regras e fontes", icon: FileText, timing: "prompt" },
  { key: "generation", title: "Modelo", hint: "LLM", icon: Bot },
  { key: "check", title: "Conferência", hint: "citação e fidelidade", icon: BadgeCheck },
];

const ALL_STEPS = [...INGESTION, ...QUERY];

const EXAMPLES = [
  "Como conecto na VPN de casa?",
  "Minha impressora não imprime",
  "Minha senha é Abc12345 e a VPN não conecta",
];

/** O que cada etapa da consulta faz. Aparece quando ainda não há rastreio (ou ele falhou). */
const QUERY_INFO: Partial<Record<StepKey, string>> = {
  masking:
    "Senha, CPF, cartão e token são escondidos antes de qualquer gravação, busca ou envio ao modelo.",
  tokenization:
    "A pergunta é quebrada de dois jeitos: em tokens do modelo de embeddings (pedaços de palavra, que viram números) e em radicais do Postgres (conectar e conecta viram conect), descartando palavras vazias.",
  embedding:
    "A pergunta vira uma lista de 384 números. Perguntas de sentido parecido ficam com vetores parecidos, mesmo sem palavras em comum.",
  search:
    "Duas buscas independentes: por significado (vetores, distância de cosseno) e por palavras (radicais). Cada uma devolve até 50 candidatos.",
  fusion:
    "As duas listas são combinadas pela regra RRF: cada trecho ganha 1 / (60 + posição) em cada lista, e as notas se somam. Os 5 melhores seguem.",
  prompt:
    "Os 5 trechos entram como dados numerados, junto com as regras do sistema, as últimas mensagens da conversa e a pergunta.",
  generation:
    "O modelo de linguagem escreve a resposta citando os trechos, ou diz que não achou, ou conversa quando a mensagem é social.",
};

function StepNode({
  step,
  active,
  ms,
  order,
  onSelect,
}: {
  step: Step;
  active: boolean;
  ms: number | undefined;
  order: number;
  onSelect: () => void;
}) {
  const Icon = step.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      style={{ "--delay": `${order * 0.12}s` } as CSSProperties}
      className={cn(
        "group flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-1 text-center",
        ms !== undefined && "chart-fade",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[3px] w-full rounded-full transition-colors",
          active ? "bg-accent" : "bg-border group-hover:bg-muted",
        )}
      />
      <span className={cn("flex max-w-full items-center gap-1 text-xs", active ? "font-semibold" : "font-medium")}>
        <Icon aria-hidden className={cn("size-3 shrink-0", active ? "text-accent" : "text-muted")} />
        <span className="truncate">{step.title}</span>
      </span>
      <span className="max-w-full truncate text-[10px] leading-tight text-muted">
        {ms !== undefined ? `${formatNumber(ms, 1)} ms` : step.hint}
      </span>
    </button>
  );
}

function Lane({
  title,
  steps,
  selected,
  trace,
  onSelect,
}: {
  title: string;
  steps: Step[];
  selected: StepKey;
  trace: RagTrace | undefined;
  onSelect: (key: StepKey) => void;
}) {
  return (
    <div className="grid items-center gap-x-3 gap-y-1 lg:grid-cols-[5.5rem_minmax(0,1fr)]">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{title}</h3>
      <div className="flex flex-wrap items-stretch gap-3">
        {steps.map((step, index) => (
          <div key={step.key} className="flex min-w-[6.5rem] flex-1 items-stretch">
            <StepNode
              step={step}
              active={selected === step.key}
              ms={trace?.timings.find((timing) => timing.stage === step.timing)?.ms}
              order={index}
              onSelect={() => onSelect(step.key)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TimingCard({ trace }: { trace: RagTrace }) {
  const total = Math.max(...trace.timings.map((timing) => timing.ms), 0.1);
  return (
    <Card className="self-start">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">Tempo por etapa</h2>
        <Badge mono>{`rastreio de ${formatNumber(trace.total_ms, 1)} ms`}</Badge>
      </div>
      <ul className="space-y-1.5 p-4">
        {trace.timings.map((timing, index) => (
          <li key={timing.stage} className="text-xs">
            <div className="mb-0.5 flex justify-between gap-2">
              <span className="truncate text-muted">{timing.label}</span>
              <span className="font-mono tabular-nums">{formatNumber(timing.ms, 1)} ms</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="chart-bar-h h-full rounded-full bg-accent"
                style={
                  {
                    width: `${Math.max(2, (timing.ms / total) * 100)}%`,
                    "--delay": `${index * 0.08}s`,
                  } as CSSProperties
                }
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
        O modelo de linguagem não entra: não é chamado aqui.
      </p>
    </Card>
  );
}

function ChunkDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const chunk = useQuery(ragChunkQuery(id));
  return (
    <Drawer
      open={id !== null}
      onOpenChange={(open) => !open && onClose()}
      title={chunk.data?.title ?? "Anatomia do trecho"}
      description="O que a ingestão guardou: texto, tokens, radicais e vetor."
    >
      {chunk.isPending && id !== null ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : chunk.isError ? (
        <p role="alert" className="text-danger">
          {chunk.error.message}
        </p>
      ) : chunk.data ? (
        <ChunkAnatomyView chunk={chunk.data} />
      ) : null}
    </Drawer>
  );
}

export function RagFlowPage() {
  const overview = useQuery(ragOverviewQuery);
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<StepKey>("tokenization");
  const [openChunk, setOpenChunk] = useState<string | null>(null);
  const [runs, setRuns] = useState(0);
  const mutation = useMutation({
    mutationFn: traceQuestion,
    onSuccess: () => setRuns((count) => count + 1),
  });
  const trace = mutation.data;

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (text) mutation.mutate(text);
  }

  const step = ALL_STEPS.find((item) => item.key === selected) ?? ALL_STEPS[0];
  const timing = trace?.timings.find((item) => item.stage === step?.timing);
  const ingestionKey = INGESTION.find((item) => item.key === selected)?.key;

  function renderDetail() {
    if (ingestionKey) {
      return (
        <IngestionStage
          step={ingestionKey as "doc" | "text" | "chunks" | "embed" | "index"}
          overview={overview.data}
        />
      );
    }
    if (selected === "check") return <CheckStage />;
    if (!trace) {
      return (
        <div className="space-y-3">
          <p className="text-sm">{QUERY_INFO[selected]}</p>
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">
            Faça uma pergunta de teste acima para ver esta etapa com dados reais.
          </p>
        </div>
      );
    }
    switch (selected) {
      case "masking":
        return <MaskingStage trace={trace} />;
      case "tokenization":
        return <TokenizationStage trace={trace} />;
      case "embedding":
        return <EmbeddingStage trace={trace} />;
      case "search":
        return <SearchStage trace={trace} onOpen={setOpenChunk} />;
      case "fusion":
        return <FusionStage trace={trace} onOpen={setOpenChunk} />;
      case "prompt":
        return <PromptStage trace={trace} />;
      case "generation":
        return <GenerationStage trace={trace} />;
      default:
        return null;
    }
  }

  const data = overview.data;
  const stats: [string | number, string][] = data
    ? [
        [data.documents, "documentos"],
        [data.chunks, "trechos"],
        [formatNumber(data.avg_words, 1), "palavras/trecho"],
        [data.params.embedding_dimensions, "dimensões"],
        [`${data.params.calls_today} / ${data.params.daily_limit}`, "chamadas hoje"],
      ]
    : [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Fluxo do RAG</h1>
          <p className="text-sm text-muted">
            Como o assistente transforma documentos em respostas, com dados reais.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {data ? (
            stats.map(([value, label]) => (
              <div key={label} className="rounded-lg bg-surface-2 px-2.5 py-1 text-center">
                <div className="text-sm leading-tight font-semibold tabular-nums">{value}</div>
                <div className="text-[11px] leading-tight text-muted">{label}</div>
              </div>
            ))
          ) : (
            <Skeleton className="h-9 w-72" />
          )}
        </div>
      </div>

      <Card className="p-3">
        <form onSubmit={submit} className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Pergunta de teste: Como conecto na VPN de casa?"
              aria-label="Pergunta de teste"
              maxLength={500}
              className="h-9"
            />
            <Button
              type="submit"
              variant="primary"
              className="h-9"
              disabled={mutation.isPending || !question.trim()}
            >
              {mutation.isPending && <Loader2 aria-hidden className="size-4 animate-spin" />}
              Rastrear
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Exemplos:</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuestion(example)}
                className="cursor-pointer rounded-md border border-border px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
              >
                {example}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-muted">
              Roda só a busca: não chama o modelo, não gasta o limite e não grava nada.
            </span>
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-danger">
              {mutation.error.message}
            </p>
          )}
        </form>
      </Card>

      <Card className="space-y-2 p-3" key={runs}>
        <Lane title="Ingestão" steps={INGESTION} selected={selected} trace={undefined} onSelect={setSelected} />
        <Lane title="Consulta" steps={QUERY} selected={selected} trace={trace} onSelect={setSelected} />
      </Card>

      <div className={cn("grid items-start gap-3", trace && "xl:grid-cols-[minmax(0,1fr)_17rem]")}>
        <Card>
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold">
              {step?.title}{" "}
              <span className="font-normal text-muted">· {ingestionKey ? "ingestão" : "consulta"}</span>
            </h2>
            {timing && <Badge mono>{formatNumber(timing.ms, 1)} ms</Badge>}
          </div>
          <div className="p-4" aria-live="polite">
            {renderDetail()}
          </div>
        </Card>
        {trace && <TimingCard trace={trace} />}
      </div>

      <ChunkDrawer id={openChunk} onClose={() => setOpenChunk(null)} />
    </section>
  );
}
