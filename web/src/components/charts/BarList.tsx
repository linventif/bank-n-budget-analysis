import { For, Show } from "solid-js";
import type { Category } from "../../api";
import { money, money0, percent } from "../../format";
import { CategoryIcon, Ico } from "../ui";

export type BarRow = {
  key: string;
  category: Category | null;
  label: string;
  value: number;
  /** Repère de comparaison (moyenne) dessiné comme un trait sur la barre. */
  reference?: number;
  count?: number;
  onClick?: () => void;
};

/**
 * Barres horizontales classées, une seule teinte : comparer des parts entre elles.
 * Chaque ligne porte son libellé et sa valeur (lisible sans survol).
 */
export function BarList(props: { rows: BarRow[]; total: number; referenceLabel?: string }) {
  const max = () => Math.max(1, ...props.rows.map((r) => Math.max(r.value, r.reference ?? 0)));
  return (
    <ul class="flex flex-col gap-1">
      <For each={props.rows}>
        {(r) => {
          const w = () => (Math.max(r.value, 0) / max()) * 100;
          const ref = () => (r.reference != null && r.reference > 0 ? (r.reference / max()) * 100 : null);
          const tip = () =>
            `${r.label} : ${money(r.value)}` +
            (r.count != null ? ` · ${r.count} opération${r.count > 1 ? "s" : ""}` : "") +
            (r.reference != null ? ` · ${props.referenceLabel ?? "référence"} ${money0(r.reference)}` : "");
          return (
            <li>
              <button
                type="button"
                class="hover:bg-base-200 focus-visible:bg-base-200 grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 rounded-xl px-2 py-1.5 text-left outline-none"
                onClick={() => r.onClick?.()}
                title={tip()}
                aria-label={tip()}
              >
                <CategoryIcon category={r.category} size="sm" />
                <div class="min-w-0">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="truncate text-sm">{r.label}</span>
                    <span class="text-muted num shrink-0 text-xs">{props.total > 0 ? percent(r.value / props.total) : ""}</span>
                  </div>
                  <div class="relative mt-1 h-2">
                    <div class="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `${w()}%`, background: "var(--series-1)" }} />
                    <Show when={ref()}>
                      <div
                        class="absolute -top-1 -bottom-1 w-0.5 rounded-full"
                        style={{ left: `calc(${ref()}% - 1px)`, background: "var(--ink-muted)" }}
                      />
                    </Show>
                  </div>
                </div>
                <div class="min-w-[5.5rem] text-right">
                  <div class="num text-sm font-semibold">{money0(r.value)}</div>
                  <Show when={r.reference != null}>
                    <div class="text-muted num text-[11px]">
                      {props.referenceLabel ?? "réf."} {money0(r.reference!)}
                    </div>
                  </Show>
                </div>
              </button>
            </li>
          );
        }}
      </For>
      <Show when={props.rows.some((r) => r.reference != null)}>
        <li class="text-muted mt-1 flex items-center gap-1.5 px-2 text-[11px]">
          <span class="inline-block h-3 w-0.5 rounded-full" style={{ background: "var(--ink-muted)" }} />
          {props.referenceLabel ?? "Référence"}
          <Ico icon="lucide:info" class="ml-1 opacity-70" />
          <span>Clique sur une catégorie pour voir ses opérations</span>
        </li>
      </Show>
    </ul>
  );
}
