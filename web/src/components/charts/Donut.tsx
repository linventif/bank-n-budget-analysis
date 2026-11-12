import { createSignal, For, Show } from "solid-js";
import { money0, percent } from "../../format";

export type Slice = { key: string; label: string; value: number; color: string; onClick?: () => void };

const TAU = Math.PI * 2;

/** Arc d'anneau entre deux angles (0 = midi, sens horaire). */
function arc(cx: number, cy: number, r: number, r0: number, a0: number, a1: number) {
  const p = (rad: number, a: number) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(r, a0);
  const [x1, y1] = p(r, a1);
  const [x2, y2] = p(r0, a1);
  const [x3, y3] = p(r0, a0);
  return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
}

/**
 * Répartition en anneau (≤ 6 parts + « Autres ») avec total au centre, séparation de 2 px
 * couleur du fond, survol et clic par part ; la légende chiffrée sert de vue tableau.
 */
export function Donut(props: { slices: Slice[]; centerLabel: string; ariaLabel: string; size?: number }) {
  const [hover, setHover] = createSignal<string | null>(null);
  const size = () => props.size ?? 180;
  const parts = () => props.slices.filter((s) => s.value > 0);
  const total = () => parts().reduce((a, s) => a + s.value, 0);
  const geometry = () => {
    let a = 0;
    return parts().map((s) => {
      const span = total() ? (s.value / total()) * TAU : 0;
      const g = { s, a0: a, a1: a + span };
      a += span;
      return g;
    });
  };
  const focused = () => parts().find((s) => s.key === hover()) ?? null;
  const c = () => size() / 2;
  const R = () => size() / 2 - 2;
  const r0 = () => R() * 0.62;

  return (
    <div class="flex flex-wrap items-center gap-x-6 gap-y-4">
      <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`} role="img" aria-label={props.ariaLabel} class="shrink-0">
        <For each={geometry()}>
          {(g) => (
            <Show
              when={g.a1 - g.a0 < TAU - 1e-6}
              fallback={
                <>
                  <circle cx={c()} cy={c()} r={(R() + r0()) / 2} fill="none" stroke={g.s.color} stroke-width={R() - r0()} />
                </>
              }
            >
              <path
                d={arc(c(), c(), hover() === g.s.key ? R() + 1 : R(), r0(), g.a0, g.a1)}
                fill={g.s.color}
                stroke="var(--color-base-100)"
                stroke-width="2"
                stroke-linejoin="round"
                opacity={hover() && hover() !== g.s.key ? 0.45 : 1}
                class={g.s.onClick ? "cursor-pointer" : ""}
                tabindex="0"
                aria-label={`${g.s.label} : ${money0(g.s.value)}, ${percent(g.s.value / total())}`}
                onPointerEnter={() => setHover(g.s.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(g.s.key)}
                onBlur={() => setHover(null)}
                onClick={() => g.s.onClick?.()}
              />
            </Show>
          )}
        </For>
        <text x={c()} y={c() - 6} text-anchor="middle" font-size="11" fill="var(--ink-muted)">
          {focused()?.label.slice(0, 18) ?? props.centerLabel}
        </text>
        <text x={c()} y={c() + 14} text-anchor="middle" font-size="18" font-weight="600" fill="var(--ink)">
          {money0(focused()?.value ?? total())}
        </text>
        <Show when={focused()}>
          <text x={c()} y={c() + 32} text-anchor="middle" font-size="11" fill="var(--ink-2)">
            {percent(focused()!.value / total())}
          </text>
        </Show>
      </svg>
      <ul class="flex min-w-48 flex-1 flex-col gap-0.5">
        <For each={parts()}>
          {(s) => (
            <li>
              <button
                class={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-sm ${hover() === s.key ? "bg-base-200" : ""} ${s.onClick ? "hover:bg-base-200" : "cursor-default"}`}
                onPointerEnter={() => setHover(s.key)}
                onPointerLeave={() => setHover(null)}
                onClick={() => s.onClick?.()}
              >
                <span class="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
                <span class="min-w-0 flex-1 truncate">{s.label}</span>
                <span class="num font-semibold">{money0(s.value)}</span>
                <span class="text-muted num w-10 text-right text-xs">{percent(s.value / total())}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
