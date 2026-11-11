import { useNavigate } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../api";
import { Heatmap, type HeatRow } from "../components/charts/Heatmap";
import { MonthlyColumns } from "../components/charts/MonthlyColumns";
import { Card, Empty, Ico, Spinner } from "../components/ui";
import { money0, percent } from "../format";
import { errorText, store } from "../store";

const RANGES = [6, 12, 24] as const;

export default function Trends() {
  const [range, setRange] = createSignal<number>(12);
  const navigate = useNavigate();
  const [trends] = createResource(
    () => ({ n: range(), v: store.version() }),
    ({ n }) => api.trends(n),
  );
  const t = () => trends.latest;

  const rows = createMemo<HeatRow[]>(() =>
    (t()?.rows ?? []).map((r) => {
      const cat = r.category_id != null ? store.categoryById().get(r.category_id) ?? null : null;
      return { key: String(r.category_id), category: cat, label: cat?.name ?? "Non classé", values: r.values, average: r.average, total: r.total };
    }),
  );
  const monthly = createMemo(() =>
    (t()?.months ?? []).map((m, i) => ({ month: m, expenses_cents: t()!.expenses[i], income_cents: t()!.income[i] })),
  );
  const totals = createMemo(() => {
    const e = t()?.expenses.reduce((a, b) => a + b, 0) ?? 0;
    const inc = t()?.income.reduce((a, b) => a + b, 0) ?? 0;
    const n = Math.max(t()?.months.length ?? 1, 1);
    return { e, inc, n, avgE: e / n, avgI: inc / n, rate: inc > 0 ? (inc - e) / inc : null };
  });

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Tendances</h1>
          <p class="text-muted text-sm">Évolution des dépenses par catégorie</p>
        </div>
        <div class="tabs tabs-box tabs-sm" role="radiogroup" aria-label="Période">
          <For each={RANGES}>
            {(r) => (
              <button role="radio" aria-checked={range() === r} class={`tab ${range() === r ? "tab-active" : ""}`} onClick={() => setRange(r)}>
                {r} mois
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={trends.error}>
        <div role="alert" class="alert alert-error">
          <Ico icon="lucide:circle-alert" /> {errorText(trends.error)}
        </div>
      </Show>

      <Show when={t()} fallback={<div class="flex justify-center py-24"><Spinner class="loading-lg" /></div>}>
        <Show when={t()!.months.length} fallback={<Card><Empty icon="lucide:chart-column" title="Pas encore de données" /></Card>}>
          <div class={`flex flex-col gap-5 ${trends.loading ? "refetching" : ""}`}>
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="card-surface p-5">
                <div class="text-ink-2 text-sm">Dépenses moyennes</div>
                <div class="mt-1 text-3xl font-semibold">{money0(totals().avgE)}</div>
                <div class="text-muted text-sm">par mois, sur {totals().n} mois</div>
              </div>
              <div class="card-surface p-5">
                <div class="text-ink-2 text-sm">Revenus moyens</div>
                <div class="mt-1 text-3xl font-semibold">{money0(totals().avgI)}</div>
                <div class="text-muted text-sm">par mois</div>
              </div>
              <div class="card-surface p-5">
                <div class="text-ink-2 text-sm">Taux d'épargne</div>
                <div class={`mt-1 flex items-center gap-2 text-3xl font-semibold ${(totals().rate ?? 0) >= 0 ? "text-gain" : "text-error"}`}>
                  <Show when={totals().rate != null}>
                    <Ico icon={totals().rate! >= 0 ? "lucide:trending-up" : "lucide:trending-down"} class="text-2xl" />
                  </Show>
                  {totals().rate == null ? "—" : percent(totals().rate!)}
                </div>
                <div class="text-muted text-sm">des revenus sur la période</div>
              </div>
            </div>

            <Card title="Dépenses par catégorie et par mois" subtitle="Plus la case est intense, plus la dépense est élevée · clique pour voir les opérations">
              <Heatmap
                months={t()!.months}
                rows={rows()}
                onCell={(r, m) => navigate(`/operations?month=${m}&category=${r.category?.id ?? "none"}&kind=expense`)}
              />
            </Card>

            <Card title="Revenus et dépenses" subtitle={`${totals().n} derniers mois`}>
              <MonthlyColumns data={monthly()} onSelect={(m) => navigate(`/?month=${m}`)} />
            </Card>
          </div>
        </Show>
      </Show>
    </div>
  );
}
