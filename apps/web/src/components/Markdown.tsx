import { Check, Copy } from "lucide-react";
import { isValidElement, type ReactNode, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/** Texto puro de um nó React (o conteúdo do <code> dentro do <pre>). */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Bloco de código com botão para copiar: o usuário cola o comando direto no terminal. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false); // sem permissão da área de transferência: o texto continua selecionável
    }
  }

  return (
    <div className="group relative mb-2 last:mb-0">
      <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 pr-20 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
        {children}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Comando copiado" : "Copiar comando"}
        className="absolute top-2 right-2 flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-muted hover:text-text"
      >
        {copied ? <Check aria-hidden className="size-3 text-accent" /> : <Copy aria-hidden className="size-3" />}
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

// HTML dentro do Markdown não é interpretado (padrão do react-markdown): o texto vem de arquivos
// enviados por administradores, mas nunca vira marcação da página.
const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline">
      {children}
    </a>
  ),
  code: ({ children, className }) => (
    <code className={cn("rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]", className)}>
      {children}
    </code>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border px-2 py-1 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/60 px-2 py-1 align-top">{children}</td>,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("min-w-0 wrap-anywhere", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
