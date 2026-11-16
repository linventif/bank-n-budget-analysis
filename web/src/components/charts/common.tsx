import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";

/** Largeur observée d'un conteneur (graphiques responsives). */
export function useWidth(initial = 320) {
  const [width, setWidth] = createSignal(initial);
  let el: HTMLElement | undefined;
  const ref = (node: HTMLElement) => (el = node);
  onMount(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  return { width, ref };
}

/** Graduations « rondes » : 0, 500, 1 000… (en centimes). */
export function niceTicks(maxCents: number, count = 4): number[] {
  const max = Math.max(maxCents, 1);
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + Math.round(step));
  return ticks;
}

/** Rectangle à extrémité arrondie (haut) et base carrée, posé sur la ligne de base. */
export function columnPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Infobulle positionnée dans le conteneur relatif du graphique ; le texte est rendu par Solid (échappé). */
export function Tooltip(props: { x: number; y: number; containerWidth: number; children: JSX.Element; visible: boolean; width?: number }) {
  const boxWidth = () => Math.min(props.width ?? 208, Math.max(props.containerWidth - 16, 0));
  const left = () => Math.min(Math.max(props.x + 14, 8), Math.max(props.containerWidth - boxWidth() - 8, 8));
  return (
    <Show when={props.visible}>
      <div
        role="tooltip"
        class="card-surface pointer-events-none absolute z-10 px-3 py-2 text-sm shadow-lg"
        style={{ width: `${boxWidth()}px`, left: `${left()}px`, top: `${Math.max(props.y - 12, 0)}px` }}
      >
        {props.children}
      </div>
    </Show>
  );
}

/** Ligne d'infobulle : valeur en premier (forte), série ensuite, avec un trait de couleur. */
export function TipRow(props: { color?: string; label: string; value: string; strong?: boolean }) {
  return (
    <div class="flex items-center gap-2 py-0.5">
      <Show when={props.color}>
        <span class="h-0.5 w-3 shrink-0 rounded-full" style={{ background: props.color }} />
      </Show>
      <span class={`num ${props.strong === false ? "text-ink-2" : "font-semibold"}`}>{props.value}</span>
      <span class="text-muted ml-auto truncate text-xs">{props.label}</span>
    </div>
  );
}

export function LegendItem(props: { color: string; label: string; shape?: "rect" | "line" | "dash" }) {
  return (
    <span class="text-ink-2 inline-flex items-center gap-1.5 text-xs">
      <Show
        when={props.shape === "dash"}
        fallback={
          <span class={props.shape === "line" ? "h-0.5 w-3.5 rounded-full" : "size-2.5 rounded-[3px]"} style={{ background: props.color }} />
        }
      >
        <span class="w-3.5 border-t-2 border-dashed" style={{ "border-color": props.color }} />
      </Show>
      {props.label}
    </span>
  );
}
