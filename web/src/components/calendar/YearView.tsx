import { createMemo, For } from "solid-js";
import { dayLong, money0, monthLong } from "../../format";
import { Ico } from "../ui";

type Day = { day: string; value: number; total: number; count: number; upcoming: number };

/** Douze mois comparables, avec les mêmes filtres et la même échelle de couleur. */
export function YearView(props: { year: string; today: string; days: Day[]; onMonth: (month: string) => void }) {
  const months = () => Array.from({ length: 12 }, (_, i) => `${props.year}-${String(i + 1).padStart(2, "0")}`);
  const byDay = createMemo(() => new Map(props.days.map((d) => [d.day, d])));
  const max = createMemo(() => Math.max(1, ...props.days.map((d) => Math.max(d.value, 0))));
  const fill = (value: number) =>
    value > 0 ? `color-mix(in oklab, var(--series-1) ${Math.round(8 + 40 * Math.sqrt(value / max()))}%, var(--color-base-100))` : undefined;

  return (
    <div class="grid grid-cols-2 gap-3 px-2 pb-3 sm:gap-4 sm:px-4 sm:pb-4 lg:grid-cols-3 xl:grid-cols-4" aria-label={`Les 12 mois de ${props.year}`}>
      <For each={months()}>
        {(month) => {
          const stats = createMemo(() => props.days.filter((d) => d.day.startsWith(month)));
          const total = () => stats().reduce((sum, d) => sum + d.total, 0);
          const count = () => stats().reduce((sum, d) => sum + d.count, 0);
          const label = () => monthLong(month);
          const cells = createMemo(() => {
            const year = Number(month.slice(0, 4));
            const index = Number(month.slice(5, 7)) - 1;
            const lead = (new Date(year, index, 1).getDay() + 6) % 7;
            const length = new Date(year, index + 1, 0).getDate();
            return [
              ...Array<string | null>(lead).fill(null),
              ...Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
              ...Array<string | null>(42 - lead - length).fill(null),
            ];
          });
          return (
            <button
              type="button"
              class={`group hover:border-primary/50 focus-visible:ring-primary flex min-w-0 flex-col rounded-xl border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none sm:p-3 ${
                month === props.today.slice(0, 7) ? "border-primary/50" : "border-[var(--hairline)]"
              }`}
              onClick={() => props.onMonth(month)}
              aria-label={`Ouvrir ${label()}, ${money0(total())}, ${count()} opérations`}
            >
              <div class="flex w-full items-center justify-between gap-1">
                <span class="truncate text-sm font-semibold first-letter:uppercase">{label().split(" ")[0]}</span>
                <Ico icon="lucide:arrow-up-right" class="text-muted shrink-0 text-xs group-hover:text-primary" />
              </div>
              <span class="num mb-2 mt-0.5 text-sm font-semibold sm:text-base">{money0(total())}</span>
              <div class="text-muted grid w-full grid-cols-7 text-center text-[10px]" aria-hidden="true">
                <For each={["L", "M", "M", "J", "V", "S", "D"]}>{(day) => <span>{day}</span>}</For>
              </div>
              <div class="mt-1 grid w-full grid-cols-7 gap-0.5" aria-hidden="true">
                <For each={cells()}>
                  {(day) => {
                    const stat = () => day ? byDay().get(day) : undefined;
                    const today = () => day === props.today;
                    return (
                      <span
                        class={`num relative flex aspect-square min-w-0 items-center justify-center rounded-[4px] text-[10px] sm:text-[11px] ${
                          today() ? "bg-primary text-primary-content font-semibold" : stat()?.count ? "text-base-content font-medium" : "text-muted"
                        }`}
                        style={{ background: !today() && stat() ? fill(stat()!.value) : undefined }}
                        title={day ? `${dayLong(day)} : ${money0(stat()?.total ?? 0)} · ${stat()?.count ?? 0} opérations` : undefined}
                      >
                        {day ? Number(day.slice(8, 10)) : ""}
                        {stat()?.upcoming ? <span class="border-base-content/40 absolute bottom-0 right-0 size-1 rounded-full border border-dashed" /> : null}
                      </span>
                    );
                  }}
                </For>
              </div>
              <span class="text-muted mt-2 text-[10px] sm:text-xs">{count()} opération{count() > 1 ? "s" : ""}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}
