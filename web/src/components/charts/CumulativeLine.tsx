import { createMemo, createSignal, For, Show } from "solid-js";
import { axisMoney, money0, signedMoney } from "../../format";
import { LegendItem, niceTicks, TipRow, Tooltip, useWidth } from "./common";

/**
 * Rythme de dépenses : cumul du mois choisi (série mise en avant) contre la moyenne
 * des mois précédents (contexte, en gris). En option : l'objectif du mois (trait pointillé
 * horizontal) et une estimation de fin de mois (pointillé prolongeant la courbe).
 */
export function CumulativeLine(props: {
  current: number[];
  average: number[];
  days: number;
  monthLabel: string;
  target?: number | null;
  projection?: number | null;
  height?: number;
}) {
  const { width, ref } = useWidth();
  const [hover, setHover] = createSignal<number | null>(null);
  const H = props.height ?? 230;
  const pad = { top: 16, right: 88, bottom: 26, left: 52 };

  const ticks = createMemo(() => {
    const vals = [...props.current, ...props.average, props.target ?? 0, props.projection ?? 0];
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    if (lo >= 0) return niceTicks(hi);
    const span = niceTicks(hi - lo);
    const step = span[1] - span[0] || 1;
    const out: number[] = [];
    for (let v = Math.floor(lo / step) * step; v < hi + step; v += step) out.push(v);
    return out;
  });
  const yMin = () => ticks()[0];
  const yMax = () => ticks()[ticks().length - 1] || 1;
  const plotW = () => Math.max(width() - pad.left - pad.right, 50);
  const plotH = () => H - pad.top - pad.bottom;
  const x = (d: number) => pad.left + (props.days <= 1 ? 0 : (d / (props.days - 1)) * plotW());
  const y = (v: number) => pad.top + plotH() - ((v - yMin()) / (yMax() - yMin() || 1)) * plotH();
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const xTicks = () => [1, 8, 15, 22, props.days].filter((d, i, a) => d <= props.days && a.indexOf(d) === i);
  const lastIdx = () => props.current.length - 1;
  const curEnd = () => props.current[lastIdx()] ?? 0;
  const avgEnd = () => props.average[props.average.length - 1] ?? 0;
  // Mois terminé : l'étiquette du mois va dans la marge droite, comme celle de la moyenne.
  const atEnd = () => lastIdx() >= props.days - 2;
  // Étiquettes qui se chevaucheraient : on garde celle du mois, la moyenne reste dans la légende et l'infobulle.
  const showProj = () => props.projection != null && props.current.length > 0 && !atEnd();
  const avgLabel = () =>
    !(props.current.length && atEnd() && Math.abs(y(curEnd()) - y(avgEnd())) < 30) &&
    !(showProj() && Math.abs(y(props.projection!) - y(avgEnd())) < 30);

  const onMove = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const d = Math.round(((px - pad.left) / plotW()) * (props.days - 1));
    setHover(Math.min(Math.max(d, 0), props.days - 1));
  };

  return (
    <div>
      <div class="mb-2 flex flex-wrap gap-4">
        <LegendItem color="var(--series-1)" label={props.monthLabel} shape="line" />
        <Show when={props.average.length}>
          <LegendItem color="var(--ink-muted)" label="Moyenne des mois précédents" shape="line" />
        </Show>
        <Show when={props.target != null}>
          <LegendItem color="var(--ink-2)" label="Prévu" shape="dash" />
        </Show>
        <Show when={showProj()}>
          <LegendItem color="var(--series-1)" label="Estimé : dépensé + reste prévu" shape="dash" />
        </Show>
      </div>
      <div ref={ref} class="relative w-full min-w-0 overflow-hidden">
        <svg
          width={width()}
          height={H}
          class="block touch-none"
          role="img"
          aria-label={`Dépenses cumulées de ${props.monthLabel} comparées à la moyenne`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <For each={ticks()}>
            {(t) => (
              <g>
                <line x1={pad.left} x2={pad.left + plotW()} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} />
                <text x={pad.left - 8} y={y(t)} dy="0.32em" text-anchor="end" font-size="11" class="num" fill="var(--ink-muted)">
                  {axisMoney(t)}
                </text>
              </g>
            )}
          </For>
          <For each={xTicks()}>
            {(d) => (
              <text x={x(d - 1)} y={H - 8} text-anchor="middle" font-size="11" fill="var(--ink-muted)">
                {d}
              </text>
            )}
          </For>

          <Show when={props.target != null}>
            <line
              x1={pad.left}
              x2={pad.left + plotW()}
              y1={y(props.target!)}
              y2={y(props.target!)}
              stroke="var(--ink-2)"
              stroke-width="1.5"
              stroke-dasharray="5 4"
            />
            <text x={pad.left + 6} y={y(props.target!) - 6} font-size="11" fill="var(--ink-2)" stroke="var(--color-base-100)" stroke-width="3" paint-order="stroke">
              prévu <tspan class="num" font-weight="600">{money0(props.target!)}</tspan>
            </text>
          </Show>

          <Show when={props.average.length}>
            <path d={path(props.average)} fill="none" stroke="var(--ink-muted)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <Show when={avgLabel()}>
              <text x={x(props.average.length - 1) + 8} y={y(avgEnd())} dy="0.32em" font-size="11" fill="var(--ink-2)">
                <tspan class="num" font-weight="600">{money0(avgEnd())}</tspan>
                <tspan x={x(props.average.length - 1) + 8} dy="1.2em" fill="var(--ink-muted)">moyenne</tspan>
              </text>
            </Show>
          </Show>

          <Show when={showProj()}>
            <path
              d={`M${x(lastIdx())},${y(curEnd())}L${x(props.days - 1)},${y(props.projection!)}`}
              fill="none"
              stroke="var(--series-1)"
              stroke-width="2"
              stroke-dasharray="5 4"
              stroke-linecap="round"
            />
            <circle cx={x(props.days - 1)} cy={y(props.projection!)} r="4" fill="var(--color-base-100)" stroke="var(--series-1)" stroke-width="2" />
            <text x={x(props.days - 1) + 8} y={y(props.projection!)} dy="0.32em" font-size="11" fill="var(--ink-2)">
              <tspan class="num" font-weight="600" fill="var(--ink)">{money0(props.projection!)}</tspan>
              <tspan x={x(props.days - 1) + 8} dy="1.2em" fill="var(--ink-muted)">estimé</tspan>
            </text>
          </Show>

          <Show when={props.current.length}>
            <path d={path(props.current)} fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <circle cx={x(lastIdx())} cy={y(props.current[lastIdx()])} r="4" fill="var(--series-1)" stroke="var(--color-base-100)" stroke-width="2" />
            <text
              x={atEnd() ? x(lastIdx()) + 8 : x(lastIdx())}
              y={atEnd() ? y(curEnd()) : y(curEnd()) - 12}
              dy={atEnd() ? "0.32em" : undefined}
              text-anchor={atEnd() ? "start" : "middle"}
              font-size="12"
              font-weight="600"
              class="num"
              fill="var(--ink)"
            >
              {money0(curEnd())}
            </text>
          </Show>

          <Show when={hover() != null}>
            <line x1={x(hover()!)} x2={x(hover()!)} y1={pad.top} y2={pad.top + plotH()} stroke="var(--axis)" />
            <Show when={props.average[hover()!] != null}>
              <circle cx={x(hover()!)} cy={y(props.average[hover()!])} r="4" fill="var(--ink-muted)" stroke="var(--color-base-100)" stroke-width="2" />
            </Show>
            <Show when={props.current[hover()!] != null}>
              <circle cx={x(hover()!)} cy={y(props.current[hover()!])} r="4" fill="var(--series-1)" stroke="var(--color-base-100)" stroke-width="2" />
            </Show>
          </Show>
        </svg>
        <Tooltip visible={hover() != null} x={hover() != null ? x(hover()!) : 0} y={pad.top} containerWidth={width()}>
          <Show when={hover() != null}>
            <div class="mb-1 text-xs font-semibold">Jour {hover()! + 1}</div>
            <Show when={props.current[hover()!] != null}>
              <TipRow color="var(--series-1)" label={props.monthLabel} value={money0(props.current[hover()!])} />
            </Show>
            <Show when={props.average[hover()!] != null}>
              <TipRow color="var(--ink-muted)" label="Moyenne" value={money0(props.average[hover()!])} />
            </Show>
            <Show when={props.target != null}>
              <TipRow color="var(--ink-2)" label="Prévu sur le mois" value={money0(props.target!)} strong={false} />
            </Show>
            <Show when={props.current[hover()!] != null && props.average[hover()!] != null}>
              <div class="border-base-300 mt-1 border-t pt-1">
                <TipRow
                  label="Écart"
                  value={signedMoney(props.current[hover()!] - props.average[hover()!]).replace(/,\d+/, "")}
                  strong={false}
                />
              </div>
            </Show>
          </Show>
        </Tooltip>
      </div>
    </div>
  );
}
