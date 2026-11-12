import { createMemo, createSignal, For } from "solid-js";
import { api, type Budget } from "../../api";
import { monthLong } from "../../format";
import { errorText, store } from "../../store";
import { Card, IconButton } from "../ui";

const addMonths = (m: string, n: number) => {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const thisMonth = () => addMonths(new Date().toISOString().slice(0, 7), 0);

/**
 * Calendrier du budget : quelle période s'applique à chaque mois (ex. alternance cours /
 * entreprise). Prioritaire sur le « dès » des périodes pour le suivi et le tableau de bord.
 */
export function CalendarEditor(props: { budget: Budget; onChange: () => void }) {
  const first = () => Object.keys(props.budget.calendar ?? {}).sort()[0] ?? thisMonth();
  const [offset, setOffset] = createSignal(0);
  const months = createMemo(() => Array.from({ length: 12 }, (_, i) => addMonths(first(), offset() + i)));
  const tone = (pid: number | undefined) => {
    const i = props.budget.periods.findIndex((p) => p.id === pid);
    return i < 0 ? "" : i % 2 === 0 ? "border-l-[var(--series-1)]" : "border-l-[var(--series-2)]";
  };
  const set = async (month: string, pid: number | null) => {
    try {
      await api.updateCalendar(props.budget.id, { [month]: pid });
      props.onChange();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };
  return (
    <Card
      title="Calendrier"
      subtitle="Période appliquée à chaque mois : le suivi et le tableau de bord la choisissent automatiquement"
      actions={
        <>
          <IconButton icon="lucide:chevron-left" label="Mois précédents" onClick={() => setOffset((o) => o - 6)} />
          <IconButton icon="lucide:chevron-right" label="Mois suivants" onClick={() => setOffset((o) => o + 6)} />
        </>
      }
    >
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <For each={months()}>
          {(m) => {
            const pid = () => props.budget.calendar?.[m];
            return (
              <label class={`card-surface flex flex-col gap-1 border-l-4 px-3 py-2 ${tone(pid()) || "border-l-[var(--hairline)]"}`}>
                <span class={`text-xs ${m === thisMonth() ? "font-semibold" : "text-muted"}`}>{monthLong(m)}</span>
                <select
                  class="bg-transparent text-sm font-medium outline-none"
                  value={pid() != null ? String(pid()) : ""}
                  aria-label={`Période de ${monthLong(m)}`}
                  onChange={(e) => set(m, e.currentTarget.value ? Number(e.currentTarget.value) : null)}
                >
                  <option value="">—</option>
                  <For each={props.budget.periods}>{(p) => <option value={String(p.id)}>{p.name}</option>}</For>
                </select>
              </label>
            );
          }}
        </For>
      </div>
    </Card>
  );
}
