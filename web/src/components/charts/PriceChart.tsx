import { createMemo, createSignal, For, Show } from "solid-js";
import { dayLabel, dayLong } from "../../format";
import { LegendItem, TipRow, Tooltip, useWidth } from "./common";

export type PricePoint = { day: string; value: number };

/** Graduations « rondes » sur un intervalle quelconque (cours : l'axe ne part pas de zéro). */
function rangeTicks(lo: number, hi: number, count = 4) {
  const span = Math.max(hi - lo, Math.abs(hi) * 0.01, 1e-9);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 0.999; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/**
 * Évolution d'une seule série dans le temps : trait de 2 px, voile à 10 %, valeur au bout,
 * réticule et infobulle au survol. Points facultatifs (ex. valorisations saisies) en 2e série.
 */
export function PriceChart(props: {
  data: PricePoint[];
  format: (v: number) => string;
  label: string;
  markers?: PricePoint[];
  markerLabel?: string;
  height?: number;
  /** Libellé des graduations de l'axe horizontal (par défaut : « 12 nov. »). */
  tickLabel?: (day: string) => string;
}) {
  const { width, ref } = useWidth();
  const [hover, setHover] = createSignal<number | null>(null);
  const H = () => props.height ?? 220;
  const pad = { top: 14, right: 70, bottom: 24, left: 56 };
  const ticks = createMemo(() => {
    const vals = [...props.data.map((d) => d.value), ...(props.markers ?? []).map((d) => d.value)];
    if (!vals.length) return [0, 1];
    return rangeTicks(Math.min(...vals), Math.max(...vals));
  });
  const yMin = () => ticks()[0];
  const yMax = () => ticks()[ticks().length - 1];
  const plotW = () => Math.max(width() - pad.left - pad.right, 50);
  const plotH = () => H() - pad.top - pad.bottom;
  const n = () => props.data.length;
  const x = (i: number) => pad.left + (n() <= 1 ? plotW() / 2 : (i / (n() - 1)) * plotW());
  const y = (v: number) => pad.top + plotH() - ((v - yMin()) / (yMax() - yMin() || 1)) * plotH();
  const line = () => props.data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join("");
  const area = () => (n() > 1 ? `${line()}L${x(n() - 1)},${y(yMin())}L${x(0)},${y(yMin())}Z` : "");
  // Un point de repère par date : position la plus proche dans la série.
  const markerX = (day: string) => {
    const i = props.data.findIndex((d) => d.day >= day);
    return x(i < 0 ? n() - 1 : i);
  };
  const xTicks = createMemo(() => {
    const k = Math.min(5, n());
    return k < 2 ? [] : Array.from({ length: k }, (_, j) => Math.round((j / (k - 1)) * (n() - 1)));
  });
  const onMove = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - pad.left) / plotW()) * (n() - 1));
    setHover(n() ? Math.min(Math.max(i, 0), n() - 1) : null);
  };
  const last = () => props.data[n() - 1];

  return (
    <div>
      <Show when={props.markers?.length}>
        <div class="mb-2 flex flex-wrap gap-4">
          <LegendItem color="var(--series-1)" label={props.label} shape="line" />
          <LegendItem color="var(--series-2)" label={props.markerLabel ?? "Repères"} />
        </div>
      </Show>
      <div ref={ref} class="relative w-full min-w-0 overflow-hidden">
        <svg width={width()} height={H()} class="block touch-none" role="img" aria-label={props.label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <For each={ticks()}>
            {(t) => (
              <g>
                <line x1={pad.left} x2={pad.left + plotW()} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
                <text x={pad.left - 8} y={y(t)} dy="0.32em" text-anchor="end" font-size="11" class="num" fill="var(--ink-muted)">
                  {props.format(t)}
                </text>
              </g>
            )}
          </For>
          <For each={xTicks()}>
            {(i) => (
              <text x={x(i)} y={H() - 6} text-anchor="middle" font-size="11" fill="var(--ink-muted)">
                {(props.tickLabel ?? dayLabel)(props.data[i].day)}
              </text>
            )}
          </For>
          <Show when={n() > 1}>
            <path d={area()} fill="var(--series-1)" fill-opacity="0.1" />
            <path d={line()} fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          </Show>
          <For each={props.markers ?? []}>
            {(m) => <circle cx={markerX(m.day)} cy={y(m.value)} r="4.5" fill="var(--series-2)" stroke="var(--color-base-100)" stroke-width="2" />}
          </For>
          <Show when={last()}>
            <circle cx={x(n() - 1)} cy={y(last()!.value)} r="4" fill="var(--series-1)" stroke="var(--color-base-100)" stroke-width="2" />
            <text x={x(n() - 1) + 8} y={y(last()!.value)} dy="0.32em" font-size="12" font-weight="600" class="num" fill="var(--ink)">
              {props.format(last()!.value)}
            </text>
          </Show>
          <Show when={hover() != null && props.data[hover()!]}>
            <line x1={x(hover()!)} x2={x(hover()!)} y1={pad.top} y2={pad.top + plotH()} stroke="var(--axis)" />
            <circle cx={x(hover()!)} cy={y(props.data[hover()!].value)} r="4" fill="var(--series-1)" stroke="var(--color-base-100)" stroke-width="2" />
          </Show>
        </svg>
        <Tooltip visible={hover() != null && !!props.data[hover()!]} x={hover() != null ? x(hover()!) : 0} y={pad.top} containerWidth={width()}>
          <Show when={hover() != null && props.data[hover()!]}>
            {(d) => (
              <>
                <div class="mb-1 text-xs font-semibold first-letter:uppercase">{dayLong(d().day)}</div>
                <TipRow color="var(--series-1)" label={props.label} value={props.format(d().value)} />
              </>
            )}
          </Show>
        </Tooltip>
      </div>
    </div>
  );
}
