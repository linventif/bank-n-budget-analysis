import { createMemo, createSignal, For, Show } from "solid-js";
import type { Category } from "../../api";
import { money, money0, monthLong, monthShortYear } from "../../format";
import { CategoryIcon } from "../ui";

export type HeatRow = { key: string; category: Category | null; label: string; values: number[]; average: number; total: number };

/**
 * Catégories × mois. Une seule teinte : plus c'est foncé, plus la dépense est forte.
 * La couleur est mélangée à la surface, donc « presque rien » se fond dans le fond dans les deux thèmes.
 * Le bouton « Montants » affiche toutes les valeurs (vue tableau, accessible sans survol).
 */
export function Heatmap(props: { months: string[]; rows: HeatRow[]; onCell?: (row: HeatRow, month: string) => void }) {
  const [showValues, setShowValues] = createSignal(false);
  const max = createMemo(() => Math.max(1, ...props.rows.flatMap((r) => r.values)));
  // Racine carrée : une grosse catégorie n'écrase pas les autres ; plancher visible dans les deux thèmes.
  const share = (v: number) => (v <= 0 ? 0 : 0.14 + 0.86 * Math.sqrt(v / max()));
  const fill = (v: number) =>
    v <= 0 ? "var(--color-base-200)" : `color-mix(in oklab, var(--series-1) ${Math.round(share(v) * 100)}%, var(--color-base-100))`;
  const ink = (v: number) => (share(v) > 0.6 ? "#ffffff" : "var(--ink)");

  return (
    <div>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div class="text-muted flex items-center gap-2 text-xs">
          <span>0 €</span>
          <span
            class="h-2 w-32 rounded-full"
            style={{ background: "linear-gradient(90deg, var(--color-base-200), color-mix(in oklab, var(--series-1) 14%, var(--color-base-100)), var(--series-1))" }}
          />
          <span class="num">{money0(max())}</span>
        </div>
        <label class="label cursor-pointer gap-2 text-xs">
          <input type="checkbox" class="toggle toggle-xs" checked={showValues()} onChange={(e) => setShowValues(e.currentTarget.checked)} />
          Montants
        </label>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full border-separate" style={{ "border-spacing": "2px" }}>
          <thead>
            <tr>
              <th class="bg-base-100 sticky left-0 z-[1] min-w-44" />
              <For each={props.months}>
                {(m) => <th class="text-muted px-1 pb-1 text-center text-[11px] font-medium whitespace-nowrap">{monthShortYear(m)}</th>}
              </For>
              <th class="text-muted px-2 pb-1 text-right text-[11px] font-medium whitespace-nowrap">Moy./mois</th>
              <th class="text-muted px-2 pb-1 text-right text-[11px] font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(r) => (
                <tr>
                  <th scope="row" class="bg-base-100 sticky left-0 z-[1] pr-2 text-left font-normal">
                    <span class="flex items-center gap-2">
                      <CategoryIcon category={r.category} size="sm" />
                      <span class="max-w-36 truncate text-sm">{r.label}</span>
                    </span>
                  </th>
                  <For each={r.values}>
                    {(v, i) => (
                      <td class="p-0">
                        <button
                          type="button"
                          class="num flex h-8 w-full min-w-11 items-center justify-center rounded-[4px] text-[10px] outline-offset-1 transition-[filter] hover:brightness-110 focus-visible:outline-2"
                          style={{ background: fill(v), color: ink(v) }}
                          title={`${r.label} · ${monthLong(props.months[i()])} : ${money(v)}`}
                          aria-label={`${r.label}, ${monthLong(props.months[i()])} : ${money(v)}`}
                          onClick={() => props.onCell?.(r, props.months[i()])}
                        >
                          <Show when={showValues() && v > 0}>{Math.round(v / 100)}</Show>
                        </button>
                      </td>
                    )}
                  </For>
                  <td class="num px-2 text-right text-sm whitespace-nowrap">{money0(r.average)}</td>
                  <td class="num text-ink-2 px-2 text-right text-sm whitespace-nowrap">{money0(r.total)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
