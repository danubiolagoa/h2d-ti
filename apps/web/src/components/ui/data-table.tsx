import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Inbox } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Quando presente, a coluna pode ser ordenada. */
  sortValue?: (row: T) => string | number;
  className?: string;
}

interface DataTableProps<T> {
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  pageSize?: number;
  onRowClick?: (row: T) => void;
  empty?: string;
  /** Com seleção, mostra as caixas de marcação. */
  selected?: ReadonlySet<string>;
  onSelectedChange?: (selected: Set<string>) => void;
}

export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  pageSize = 8,
  onRowClick,
  empty = "Nada encontrado com estes filtros.",
  selected,
  onSelectedChange,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(null);
  const [requestedPage, setPage] = useState(0);

  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.key === sort?.key);
    if (!sort || !column?.sortValue) return rows;
    const value = column.sortValue;
    return [...rows].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "pt-BR");
      return order * sort.direction;
    });
  }, [columns, rows, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Filtros podem encolher a lista: a página nunca fica além do fim.
  const page = Math.min(requestedPage, pageCount - 1);
  const visible = sorted.slice(page * pageSize, (page + 1) * pageSize);
  const selectable = Boolean(selected && onSelectedChange);
  const allVisibleSelected =
    selectable && visible.length > 0 && visible.every((row) => selected?.has(rowKey(row)));

  function toggleSort(key: string) {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 1 };
      return current.direction === 1 ? { key, direction: -1 } : null;
    });
  }

  function toggleRow(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange?.(next);
  }

  function toggleVisible() {
    const next = new Set(selected);
    for (const row of visible) {
      if (allVisibleSelected) next.delete(rowKey(row));
      else next.add(rowKey(row));
    }
    onSelectedChange?.(next);
  }

  if (sorted.length === 0) {
    return (
      <div role="status" className="px-4 py-14 text-center text-sm text-muted">
        <Inbox aria-hidden className="mx-auto mb-2 size-7" />
        <p>{empty}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">{label}</caption>
          <thead className="bg-surface-2 text-xs text-muted">
            <tr>
              {selectable && (
                <th scope="col" className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos desta página"
                    checked={allVisibleSelected}
                    onChange={toggleVisible}
                    className="size-4 cursor-pointer accent-[var(--accent)]"
                  />
                </th>
              )}
              {columns.map((column) => {
                const sortedHere = sort?.key === column.key ? sort.direction : null;
                const SortIcon =
                  sortedHere === 1 ? ArrowUp : sortedHere === -1 ? ArrowDown : ChevronsUpDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      sortedHere === 1 ? "ascending" : sortedHere === -1 ? "descending" : undefined
                    }
                    className={cn("px-3 py-2.5 font-medium whitespace-nowrap sm:px-4", column.className)}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className="inline-flex cursor-pointer items-center gap-1 hover:text-text"
                      >
                        {column.header}
                        <SortIcon aria-hidden className="size-3.5" />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === "Enter") onRowClick(row);
                        }
                      : undefined
                  }
                  className={cn(
                    "border-t border-border",
                    onRowClick && "cursor-pointer hover:bg-surface-2/60",
                    selected?.has(key) && "bg-accent-soft",
                  )}
                >
                  {selectable && (
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${key}`}
                        checked={selected?.has(key) ?? false}
                        onChange={() => toggleRow(key)}
                        className="size-4 cursor-pointer accent-[var(--accent)]"
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td key={column.key} className={cn("px-3 py-3 align-middle sm:px-4", column.className)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sorted.length > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2.5 text-xs text-muted sm:px-4">
          <span>
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} de{" "}
            {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Página anterior"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              className="flex size-10 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
            <span className="px-1">
              Página {page + 1} de {pageCount}
            </span>
            <button
              type="button"
              aria-label="Próxima página"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(page + 1)}
              className="flex size-10 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
