import { createMemo, createSignal, For, Show } from "solid-js";
import { axisMoney, money0, monthLong, monthShort, signedMoney } from "../../format";
import { columnPath, LegendItem, niceTicks, TipRow, Tooltip, useWidth } from "./common";

type Point = { month: string; expenses_cents: number; income_cents: number };

/** Revenus et dépenses par mois : colonnes groupées, une seule échelle. */
export function MonthlyColumns(props: { data: Point[]; selected?: string | null; onSelect?: (month: string) => void }) {
  const { width, ref } = useWidth();
  const [hover, setHover] = createSignal<number | null>(null);
  const H = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 52 };

  const ticks = createMemo(() =>
    niceTicks(Math.max(0, ...props.data.map((d) => Math.max(d.expenses_cents, d.income_cents)))),
  );
  const yMax = () => ticks()[ticks().length - 1] || 1;
  const plotW = () => Math.max(width() - pad.left - pad.right, 50);
  const plotH = H - pad.top - pad.bottom;
  const band = () => plotW() / Math.max(props.data.length, 1);
  const barW = () => Math.max(3, Math.min(20, (band() - 10) / 2));
  const y = (v: number) => pad.top + plotH - (Math.max(v, 0) / yMax()) * plotH;
  const x0 = (i: number) => pad.left + i * band() + band() / 2;

  const tip = () => {
    const i = hover();
    return i == null ? null : props.data[i];
  };

  return (
    <div>
      <div class="mb-2 flex flex-wrap gap-4">
        <LegendItem color="var(--series-1)" label="Dépenses" />
        <LegendItem color="var(--series-2)" label="Revenus" />
      </div>
      <div ref={ref} class="relative w-full min-w-0 overflow-hidden" onPointerLeave={() => setHover(null)}>
        <svg width={width()} height={H} role="img" aria-label="Revenus et dépenses par mois" class="block">
          <For each={ticks()}>
            {(t) => (
              <g>
                <line x1={pad.left} x2={width() - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} stroke-width="1" />
                <text x={pad.left - 8} y={y(t)} dy="0.32em" text-anchor="end" class="num" font-size="11" fill="var(--ink-muted)">
                  {axisMoney(t)}
                </text>
              </g>
            )}
          </For>
          <For each={props.data}>
            {(d, i) => {
              const sel = () => d.month === props.selected;
              return (
                <g>
                  <rect
                    x={pad.left + i() * band() + 1}
                    y={pad.top}
                    width={Math.max(band() - 2, 0)}
                    height={plotH}
                    rx="6"
                    fill={sel() || hover() === i() ? "var(--color-base-200)" : "transparent"}
                  />
                  <path d={columnPath(x0(i()) - barW() - 1, y(d.expenses_cents), barW(), y(0) - y(d.expenses_cents))} fill="var(--series-1)" />
                  <path d={columnPath(x0(i()) + 1, y(d.income_cents), barW(), y(0) - y(d.income_cents))} fill="var(--series-2)" />
                  <text
                    x={x0(i())}
                    y={H - 8}
                    text-anchor="middle"
                    font-size="11"
                    font-weight={sel() ? 600 : 400}
                    fill={sel() ? "var(--ink)" : "var(--ink-muted)"}
                  >
                    {monthShort(d.month)}
                  </text>
                  {/* Zone de survol = toute la bande du mois */}
                  <rect
                    x={pad.left + i() * band()}
                    y={0}
                    width={band()}
                    height={H}
                    fill="transparent"
                    class={props.onSelect ? "cursor-pointer" : ""}
                    tabindex="0"
                    aria-label={`${monthLong(d.month)} : dépenses ${money0(d.expenses_cents)}, revenus ${money0(d.income_cents)}`}
                    onPointerEnter={() => setHover(i())}
                    onFocus={() => setHover(i())}
                    onBlur={() => setHover(null)}
                    onClick={() => props.onSelect?.(d.month)}
                  />
                </g>
              );
            }}
          </For>
        </svg>
        <Tooltip visible={tip() != null} x={hover() != null ? x0(hover()!) : 0} y={pad.top} containerWidth={width()}>
          <Show when={tip()}>
            {(d) => (
              <>
                <div class="mb-1 text-xs font-semibold">{monthLong(d().month)}</div>
                <TipRow color="var(--series-1)" label="Dépenses" value={money0(d().expenses_cents)} />
                <TipRow color="var(--series-2)" label="Revenus" value={money0(d().income_cents)} />
                <div class="border-base-300 mt-1 border-t pt-1">
                  <TipRow label="Solde du mois" value={signedMoney(d().income_cents - d().expenses_cents).replace(/,\d+/, "")} strong={false} />
                </div>
              </>
            )}
          </Show>
        </Tooltip>
      </div>
    </div>
  );
}
