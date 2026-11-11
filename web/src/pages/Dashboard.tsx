import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createMemo, createResource, For, Show } from "solid-js";
import { api, type Budget, type CatAmount, type Summary, type Tracking } from "../api";
import { BarList } from "../components/charts/BarList";
import { CumulativeLine } from "../components/charts/CumulativeLine";
import { MonthlyColumns } from "../components/charts/MonthlyColumns";
import { Sparkline } from "../components/charts/Sparkline";
import { Card, CategoryIcon, Delta, Empty, Ico, Spinner } from "../components/ui";
import { dayLabel, money, money0, monthLong, percent, signedMoney } from "../format";
import { errorText, store } from "../store";

export default function Dashboard() {
  const [params, setParams] = useSearchParams<{ month?: string }>();
  const navigate = useNavigate();
  const [summary] = createResource(
    () => ({ month: params.month, v: store.version() }),
    ({ month }) => api.summary(month),
  );
  const [recurring] = createResource(store.version, () => api.recurring());
  const recurringExpenses = () => (recurring.latest?.items ?? []).filter((r) => r.kind === "expense" && r.status !== "stopped");
  // Budget actif : suivi du mois affiché.
  const [activeBudget] = createResource(store.version, async () => (await api.budgets()).find((b) => b.is_active) ?? null);
  const [budgetTrack] = createResource(
    () => (activeBudget.latest && month() ? { id: activeBudget.latest.id, month: month()!, v: store.version() } : false),
    ({ id, month }) => api.tracking(id, month),
  );

  const s = () => summary.latest;
  const month = () => s()?.month ?? null;
  const idx = () => (s() && month() ? s()!.months.indexOf(month()!) : -1);
  const go = (delta: number) => {
    const m = s()?.months[idx() + delta];
    if (m) setParams({ month: m });
  };

  const openCategory = (catId: number | null) =>
    navigate(`/operations?month=${month() ?? ""}&category=${catId ?? "none"}&kind=expense`);

  return (
    <div class="flex flex-col gap-5">
      {/* En-tête + filtre unique (mois), au-dessus de tout ce qu'il pilote */}
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">{month() ? monthLong(month()!) : "Tableau de bord"}</h1>
          <p class="text-muted text-sm">
            <Show when={s()?.avg_months} fallback="Pas encore assez d'historique pour comparer">
              Comparé à la moyenne des {s()!.avg_months} mois précédents
            </Show>
          </p>
        </div>
        <Show when={s()?.months.length}>
          <div class="join">
            <button class="btn btn-sm join-item" disabled={idx() <= 0} onClick={() => go(-1)} aria-label="Mois précédent">
              <Ico icon="lucide:chevron-left" />
            </button>
            <select
              class="select select-sm join-item w-44"
              value={month() ?? ""}
              onChange={(e) => setParams({ month: e.currentTarget.value })}
              aria-label="Mois"
            >
              <For each={[...(s()?.months ?? [])].reverse()}>{(m) => <option value={m}>{monthLong(m)}</option>}</For>
            </select>
            <button class="btn btn-sm join-item" disabled={idx() >= (s()?.months.length ?? 0) - 1} onClick={() => go(1)} aria-label="Mois suivant">
              <Ico icon="lucide:chevron-right" />
            </button>
          </div>
        </Show>
      </div>

      <Show when={summary.error}>
        <div role="alert" class="alert alert-error">
          <Ico icon="lucide:circle-alert" />
          {errorText(summary.error)}
        </div>
      </Show>

      <Show when={s()} fallback={<div class="flex justify-center py-24"><Spinner class="loading-lg" /></div>}>
        <Show
          when={s()!.months.length > 0}
          fallback={
            <Card>
              <Empty icon="lucide:landmark" title="Aucune opération pour l'instant">
                Connecte une banque dans <A href="/comptes" class="link">Comptes & IA</A>, puis synchronise.
              </Empty>
            </Card>
          }
        >
          <div class={`flex flex-col gap-5 ${summary.loading ? "refetching" : ""}`}>
            <ReviewBanner />
            <Kpis s={s()!} />

            <div class="grid gap-5 lg:grid-cols-5">
              <Card
                class="lg:col-span-3"
                title="Rythme de dépenses"
                subtitle={s()!.is_current_month ? "Dépenses cumulées depuis le 1er du mois" : "Dépenses cumulées sur le mois"}
              >
                <CumulativeLine
                  current={s()!.cumulative_current}
                  average={s()!.cumulative_average}
                  days={s()!.days_in_month}
                  monthLabel={monthLong(month()!)}
                />
              </Card>
              <Budgets class="lg:col-span-2" budget={activeBudget.latest ?? null} tracking={budgetTrack.latest ?? null} />
            </div>

            <div class="grid gap-5 lg:grid-cols-5">
              <Card
                class="lg:col-span-3"
                title="Dépenses par catégorie"
                subtitle={`${money0(s()!.totals.expenses_cents)} ce mois-ci`}
              >
                <Show when={s()!.by_category.some((c) => c.amount_cents > 0)} fallback={<Empty icon="lucide:receipt-text" title="Aucune dépense ce mois-ci" />}>
                  <CategoryBars rows={s()!.by_category} total={s()!.totals.expenses_cents} onOpen={openCategory} />
                </Show>
              </Card>
              <Card class="lg:col-span-2" title="Où part l'argent" subtitle="Marchands les plus coûteux du mois">
                <Show when={s()!.top_merchants.length} fallback={<Empty icon="lucide:store" title="Aucun marchand ce mois-ci" />}>
                  <ul class="flex flex-col">
                    <For each={s()!.top_merchants}>
                      {(m) => (
                        <li>
                          <A
                            href={`/operations?month=${month()}&q=${encodeURIComponent(m.merchant)}`}
                            class="hover:bg-base-200 flex items-center gap-3 rounded-xl px-2 py-2"
                          >
                            <CategoryIcon category={m.category_id != null ? store.categoryById().get(m.category_id) : null} size="sm" />
                            <div class="min-w-0 flex-1">
                              <div class="truncate text-sm">{m.name}</div>
                              <div class="text-muted text-xs">
                                {m.count} opération{m.count > 1 ? "s" : ""}
                              </div>
                            </div>
                            <span class="num text-sm font-semibold">{money0(m.amount_cents)}</span>
                          </A>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Card>
            </div>

            <Card title="Revenus et dépenses" subtitle="12 derniers mois · clique sur un mois pour l'afficher">
              <MonthlyColumns data={s()!.monthly} selected={month()} onSelect={(m) => setParams({ month: m })} />
            </Card>

            <Card
              title="Paiements récurrents"
              subtitle="Abonnements et dépenses régulières détectés automatiquement"
              actions={
                <Show when={recurringExpenses().length}>
                  <span class="text-muted text-sm">
                    <span class="num text-base-content font-semibold">{money(recurring.latest!.monthly_total_cents)}</span> / mois
                  </span>
                  <A href="/budget?tab=recurrents" class="btn btn-ghost btn-xs">
                    Tout voir <Ico icon="lucide:arrow-right" />
                  </A>
                </Show>
              }
            >
              <Show
                when={recurringExpenses().length}
                fallback={<Empty icon="lucide:repeat" title="Aucun paiement récurrent détecté">Il faut au moins 3 mois d'historique.</Empty>}
              >
                <ul class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  <For each={recurringExpenses().slice(0, 10)}>
                    {(r) => {
                      const late = () => r.status === "late";
                      return (
                        <li class="flex items-center gap-3 py-1.5">
                          <CategoryIcon category={r.category_id != null ? store.categoryById().get(r.category_id) : null} size="sm" />
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-sm">{r.name}</div>
                            <div class="text-muted text-xs">
                              <Show when={r.next_day} fallback={`dernier : ${dayLabel(r.last_day)}`}>
                                {late() ? (
                                  <span class="text-ink-2 inline-flex items-center gap-1">
                                    <Ico icon="lucide:clock" /> attendu le {dayLabel(r.next_day!)} — résilié ?
                                  </span>
                                ) : (
                                  <>prochain vers le {dayLabel(r.next_day!)}</>
                                )}
                              </Show>
                            </div>
                          </div>
                          <span class="num text-sm font-semibold">{money(r.amount_cents)}</span>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
            </Card>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function ReviewBanner() {
  const counts = () => store.status()?.counts;
  const ai = () => store.status()?.ai;
  const classify = async () => {
    try {
      const r = await api.classify(false);
      store.toast(r.ai_started ? "Classification lancée avec l'IA locale" : "Règles appliquées", "success");
      store.bump();
      store.refreshStatus();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };
  return (
    <Show when={(counts()?.uncategorized ?? 0) > 0 || (counts()?.to_review ?? 0) > 0}>
      <div class="card-surface flex flex-wrap items-center gap-3 px-4 py-3">
        <span class="bg-warning/15 inline-flex size-9 items-center justify-center rounded-xl text-lg">
          <Ico icon="lucide:wand-sparkles" />
        </span>
        <div class="min-w-0 flex-1 text-sm">
          <Show when={(counts()?.uncategorized ?? 0) > 0}>
            <div>
              <span class="font-semibold">{counts()!.uncategorized} opérations</span> sans catégorie
            </div>
          </Show>
          <Show when={(counts()?.to_review ?? 0) > 0}>
            <div class="text-ink-2">{counts()!.to_review} classements de l'IA à vérifier</div>
          </Show>
        </div>
        <Show when={(counts()?.to_review ?? 0) > 0}>
          <A href="/operations?source=review" class="btn btn-sm">
            Vérifier
          </A>
        </Show>
        <Show when={(counts()?.uncategorized ?? 0) > 0}>
          <Show when={!ai()?.progress.running}>
            <button class="btn btn-sm btn-primary" onClick={classify} disabled={!ai()?.health?.model_installed} title={ai()?.health?.model_installed ? "" : "Démarre le serveur IA (voir Comptes & IA)"}>
              <Ico icon="lucide:sparkles" /> Classer avec l'IA
            </button>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function Kpis(props: { s: Summary }) {
  const s = () => props.s;
  const net = () => s().totals.income_cents - s().totals.expenses_cents;
  // Mois en cours : comparer au cumul moyen à la même date, pas au mois complet.
  const expenseRef = () => {
    if (s().is_current_month && s().cumulative_average.length) {
      const day = Math.max(s().cumulative_current.length - 1, 0);
      return { value: s().cumulative_average[Math.min(day, s().cumulative_average.length - 1)], label: "vs moy. à date" };
    }
    return { value: s().avg.expenses_cents, label: "vs moyenne" };
  };
  const spark = (key: "expenses_cents" | "income_cents") => s().monthly.map((m) => m[key]);

  return (
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="card-surface flex flex-col gap-2 p-5 sm:col-span-2 xl:col-span-1">
        <div class="text-ink-2 text-sm">Dépenses</div>
        <div class="flex items-end justify-between gap-3">
          <div class="text-5xl leading-none font-semibold tracking-tight">{money0(s().totals.expenses_cents)}</div>
          <Sparkline values={spark("expenses_cents")} label="Dépenses des 12 derniers mois" />
        </div>
        <Show when={s().avg_months > 0}>
          <Delta value={s().totals.expenses_cents} reference={expenseRef().value} upIsGood={false} suffix={expenseRef().label} />
        </Show>
      </div>

      <div class="card-surface flex flex-col gap-2 p-5">
        <div class="text-ink-2 text-sm">Revenus</div>
        <div class="flex items-end justify-between gap-3">
          <div class="text-3xl leading-none font-semibold">{money0(s().totals.income_cents)}</div>
          <Sparkline values={spark("income_cents")} color="var(--series-2)" label="Revenus des 12 derniers mois" />
        </div>
        <Show when={s().avg_months > 0}>
          <Show when={!s().is_current_month} fallback={<span class="text-muted text-sm">moyenne {money0(s().avg.income_cents)} / mois</span>}>
            <Delta value={s().totals.income_cents} reference={s().avg.income_cents} upIsGood suffix="vs moyenne" />
          </Show>
        </Show>
      </div>

      <div class="card-surface flex flex-col gap-2 p-5">
        <div class="text-ink-2 text-sm">Solde du mois</div>
        <div class={`text-3xl leading-none font-semibold ${net() >= 0 ? "text-gain" : ""}`}>{signedMoney(net()).replace(/,\d+/, "")}</div>
        <span class="text-muted text-sm">
          <Show when={s().totals.income_cents > 0} fallback="aucun revenu ce mois-ci">
            {net() >= 0 ? `${percent(net() / s().totals.income_cents)} des revenus épargnés` : "dépenses supérieures aux revenus"}
          </Show>
        </span>
      </div>

      <A href="/comptes" class="card-surface hover:bg-base-200/50 flex flex-col gap-2 p-5">
        <div class="text-ink-2 flex items-center gap-1.5 text-sm">
          Sur les comptes <Ico icon="lucide:arrow-up-right" class="text-xs" />
        </div>
        <div class="text-3xl leading-none font-semibold">{money0(s().balance_cents)}</div>
        <span class="text-muted text-sm">solde actuel, tous comptes</span>
      </A>
    </div>
  );
}

function CategoryBars(props: { rows: CatAmount[]; total: number; onOpen: (id: number | null) => void }) {
  const rows = createMemo(() => {
    const spent = props.rows.filter((r) => r.amount_cents > 0);
    // Au-delà de 9 lignes, la queue est regroupée.
    const head = spent.slice(0, 9);
    const tail = spent.slice(9);
    const out = head.map((r) => {
      const cat = r.category_id != null ? store.categoryById().get(r.category_id) ?? null : null;
      return {
        key: String(r.category_id),
        category: cat,
        label: cat?.name ?? "Non classé",
        value: r.amount_cents,
        reference: r.avg_cents || undefined,
        count: r.count,
        onClick: () => props.onOpen(r.category_id),
      };
    });
    if (tail.length) {
      out.push({
        key: "other",
        category: null,
        label: `${tail.length} autres catégories`,
        value: tail.reduce((a, r) => a + r.amount_cents, 0),
        reference: tail.reduce((a, r) => a + r.avg_cents, 0) || undefined,
        count: tail.reduce((a, r) => a + r.count, 0),
        onClick: () => {},
      });
    }
    return out;
  });
  return <BarList rows={rows()} total={props.total} referenceLabel="moy." />;
}

function Budgets(props: { budget: Budget | null; tracking: Tracking | null; class?: string }) {
  const rows = createMemo(() => {
    const b = props.budget;
    const t = props.tracking;
    if (!b || !t) return [];
    const byLine = new Map(t.lines.map((x) => [x.line_id, x]));
    return b.lines
      .filter((l) => l.kind === "expense")
      .map((l) => ({ line: l, track: byLine.get(l.id) }))
      .filter((r) => (r.track?.planned_cents ?? 0) > 0 && r.track?.actual_cents != null)
      .sort((a, b) => b.track!.planned_cents! - a.track!.planned_cents!)
      .slice(0, 7);
  });
  return (
    <Card
      class={props.class}
      title={props.budget ? `Budget · ${props.tracking?.period?.name ?? props.budget.name}` : "Budget"}
      subtitle={props.tracking?.is_current_month ? "Réel à ce jour / prévu" : "Réel / prévu sur le mois"}
      actions={
        <Show when={props.budget}>
          <A href={`/budget${props.tracking ? `?month=${props.tracking.month}` : ""}`} class="btn btn-ghost btn-xs">
            Détail <Ico icon="lucide:arrow-right" />
          </A>
        </Show>
      }
    >
      <Show
        when={props.budget}
        fallback={
          <Empty icon="lucide:calculator" title="Pas encore de budget">
            Prévois tes postes de dépense dans <A href="/budget" class="link">Budget</A>.
          </Empty>
        }
      >
        <ul class="flex flex-col gap-3.5">
          <For each={rows()}>
            {(r) => {
              const planned = () => r.track!.planned_cents!;
              const actual = () => r.track!.actual_cents!;
              const ratio = () => actual() / planned();
              const level = () => (ratio() > 1.1 ? "over" : props.tracking?.is_current_month && actual() === 0 ? "pending" : "ok");
              const fill = () => (level() === "over" ? "var(--color-error)" : ratio() > 1 ? "var(--color-warning)" : "var(--series-1)");
              return (
                <li>
                  <div class="mb-1.5 flex items-center gap-2.5">
                    <CategoryIcon category={r.line.category_id != null ? store.categoryById().get(r.line.category_id) : null} size="sm" />
                    <span class="min-w-0 flex-1 truncate text-sm">{r.line.name}</span>
                    <span class="num text-sm">
                      <span class="font-semibold">{money0(actual())}</span>
                      <span class="text-muted"> / {money0(planned())}</span>
                    </span>
                  </div>
                  <div
                    class="h-2 overflow-hidden rounded-full"
                    style={{ background: "color-mix(in oklab, var(--series-1) 16%, var(--color-base-100))" }}
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={planned()}
                    aria-valuenow={actual()}
                    aria-label={`${r.line.name} : ${money0(actual())} sur ${money0(planned())}`}
                  >
                    <div class="h-full rounded-full" style={{ width: `${Math.min(ratio(), 1) * 100}%`, background: fill() }} />
                  </div>
                  <Show when={level() === "over"}>
                    <div class="text-error mt-1 flex items-center gap-1 text-xs">
                      <Ico icon="lucide:circle-alert" /> {money0(actual() - planned())} au-dessus du prévu
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </Card>
  );
}
