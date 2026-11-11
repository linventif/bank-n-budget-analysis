import { Show } from "solid-js";

/** Tendance compacte d'une tuile : courbe discrète, point courant en couleur d'accent. */
export function Sparkline(props: { values: number[]; color?: string; label: string }) {
  const W = 120;
  const H = 36;
  const p = 5;
  const max = () => Math.max(1, ...props.values);
  const min = () => Math.min(0, ...props.values);
  const x = (i: number) => p + (props.values.length <= 1 ? 0 : (i / (props.values.length - 1)) * (W - 2 * p));
  const y = (v: number) => p + (H - 2 * p) * (1 - (v - min()) / (max() - min() || 1));
  const d = () => props.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = () => props.values.length - 1;
  return (
    <Show when={props.values.length > 1}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.label} class="block">
        <path d={d()} fill="none" stroke="var(--axis)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <circle
          cx={x(last())}
          cy={y(props.values[last()])}
          r="4"
          fill={props.color ?? "var(--series-1)"}
          stroke="var(--color-base-100)"
          stroke-width="2"
        />
      </svg>
    </Show>
  );
}
