import { For, Show } from "solid-js";
import { money0, percent } from "../../format";

export type Segment = { key: string; label: string; value: number; color: string };

/**
 * Une dépense totale découpée en quelques parts (≤ 6) : blocs proportionnels séparés de 2 px,
 * part en % imprimée dans le bloc quand elle tient, légende des noms dessous.
 */
export function SegmentedBar(props: { segments: Segment[]; ariaLabel: string }) {
  const total = () => props.segments.reduce((a, s) => a + Math.max(s.value, 0), 0);
  const parts = () => props.segments.filter((s) => s.value > 0);
  return (
    <div>
      <div class="flex h-7 w-full gap-0.5" role="img" aria-label={props.ariaLabel}>
        <For each={parts()}>
          {(s) => {
            const share = () => (total() ? s.value / total() : 0);
            return (
              <div
                class="flex h-full min-w-1 items-center overflow-hidden rounded-[4px] px-2"
                style={{ width: `${share() * 100}%`, background: s.color }}
                title={`${s.label} : ${money0(s.value)} (${percent(share())})`}
              >
                {/* Libellé seulement s'il tient dans le bloc. */}
                <Show when={share() > 0.09}>
                  <span class="num text-xs font-semibold whitespace-nowrap text-white">{percent(share())}</span>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <For each={parts()}>
          {(s) => (
            <span class="text-ink-2 inline-flex items-center gap-1.5 text-xs">
              <span class="size-2.5 rounded-[3px]" style={{ background: s.color }} />
              {s.label}
            </span>
          )}
        </For>
      </div>
    </div>
  );
}
