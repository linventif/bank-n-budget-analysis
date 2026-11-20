import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { api, type Budget, type CatAmount, type Portfolio, type Summary, type Tracking } from "../api";
import { budgetMonthLabel } from "../budget";
import { BarList } from "../components/charts/BarList";
import { Donut } from "../components/charts/Donut";
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
  const [portfolio] = createResource(store.version, () => api.portfolio().catch(() => null));
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
            <Kpis s={s()!} portfolio={portfolio.latest && portfolio.latest.net_invested_cents > 0 ? portfolio.latest : null} />

            <div class="grid gap-5 lg:grid-cols-5">
              <Card
                class="lg:col-span-3"
                title="Rythme de dépenses"
                subtitle="Cumul comparé aux deux mois précédents et à la moyenne"
              >
                <CumulativeLine
                  current={s()!.cumulative_current}
                  average={s()!.cumulative_average}
                  days={s()!.days_in_month}
                  monthLabel={budgetMonthLabel(activeBudget.latest, month()!)}
                  previous={(s()!.cumulative_previous ?? []).map((curve) => ({
                    label: budgetMonthLabel(activeBudget.latest, curve.month),
                    values: curve.values,
                  }))}
                />
              </Card>
              <Budgets class="lg:col-span-2" budget={activeBudget.latest ?? null} tracking={budgetTrack.latest ?? null} />
            </div>

            <div class="grid gap-5 lg:grid-cols-5">
              <SpendingCard s={s()!} budget={activeBudget.latest ?? null} tracking={budgetTrack.latest ?? null} onOpen={openCategory} />
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

function Kpis(props: { s: Summary; portfolio?: Portfolio | null }) {
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
        <span class="text-muted text-sm">
          solde actuel, tous comptes
          <Show when={s().pending_cents < 0}> · {money0(-s().pending_cents)} en attente déduits</Show>
        </span>
        <Show when={props.portfolio}>
          <span class="text-ink-2 text-sm">
            + {money0(props.portfolio!.latest?.value_cents ?? props.portfolio!.net_invested_cents)} en compte-titres
            <span class="text-muted">{props.portfolio!.latest ? "" : " (net investi)"}</span>
          </span>
        </Show>
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

/** Dépenses du mois selon trois vues : par catégorie, prévu / non prévu (budget), vital / plaisir. */
function SpendingCard(props: { s: Summary; budget: Budget | null; tracking: Tracking | null; onOpen: (id: number | null) => void }) {
  const views = [
    { v: "detail", label: "Détail" },
    { v: "budget", label: "Budget" },
    { v: "simple", label: "Simplifié" },
  ] as const;
  const spent = () => props.s.by_category.filter((c) => c.amount_cents > 0);
  const total = () => props.s.totals.expenses_cents;
  // Détail : 5 plus grosses catégories + « Autres » (couleurs de la palette dans l'ordre fixe).
  const detailSlices = createMemo(() => {
    const colors = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];
    const head = spent().slice(0, 5);
    const tail = spent().slice(5);
    const slices = head.map((c, i) => ({
      key: String(c.category_id),
      label: c.category_id != null ? store.categoryById().get(c.category_id)?.name ?? "?" : "Non classé",
      value: c.amount_cents,
      color: colors[i],
      onClick: () => props.onOpen(c.category_id),
    }));
    if (tail.length) slices.push({ key: "autres", label: `Autres (${tail.length})`, value: tail.reduce((a, c) => a + c.amount_cents, 0), color: "var(--ink-muted)", onClick: () => {} });
    return slices;
  });

  // --- Prévu / non prévu : opérations rattachées aux postes de dépense du budget actif ---
  const planned = createMemo(() => {
    const b = props.budget;
    const t = props.tracking;
    if (!b || !t) return null;
    const byLine = new Map(t.lines.map((x) => [x.line_id, x]));
    const lines = b.lines
      .filter((l) => l.kind === "expense")
      .map((l) => ({ line: l, actual: byLine.get(l.id)?.actual_cents ?? 0, planned: byLine.get(l.id)?.planned_cents ?? 0 }))
      .filter((x) => x.actual > 0)
      .sort((a, b) => b.actual - a.actual);
    const sum = lines.reduce((a, x) => a + x.actual, 0);
    return { lines, sum, rest: Math.max(t.actual_expense_cents - sum, 0), unbudgeted: t.unbudgeted.filter((c) => c.actual_cents > 0) };
  });

  // --- Vital / plaisir : nature des catégories ---
  const natures = createMemo(() => {
    const groups = { vital: [] as CatAmount[], plaisir: [] as CatAmount[], autre: [] as CatAmount[] };
    for (const c of spent()) {
      const n = c.category_id != null ? store.categoryById().get(c.category_id)?.nature : null;
      groups[n === "vital" ? "vital" : n === "plaisir" ? "plaisir" : "autre"].push(c);
    }
    const sum = (xs: CatAmount[]) => xs.reduce((a, c) => a + c.amount_cents, 0);
    const avg = (xs: CatAmount[]) => xs.reduce((a, c) => a + c.avg_cents, 0);
    return { groups, sum, avg };
  });

  const CatList = (p: { rows: CatAmount[] }) => (
    <ul class="flex flex-col">
      <For each={p.rows.slice(0, 6)}>
        {(c) => {
          const cat = () => (c.category_id != null ? store.categoryById().get(c.category_id) : null);
          return (
            <li>
              <button class="hover:bg-base-200 flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left" onClick={() => props.onOpen(c.category_id)}>
                <CategoryIcon category={cat()} size="sm" />
                <span class="min-w-0 flex-1 truncate text-sm">{cat()?.name ?? "Non classé"}</span>
                <span class="num text-sm font-semibold">{money0(c.amount_cents)}</span>
              </button>
            </li>
          );
        }}
      </For>
      <Show when={p.rows.length > 6}>
        <li class="text-muted px-1.5 py-1 text-xs">
          + {p.rows.length - 6} autres · {money0(p.rows.slice(6).reduce((a, c) => a + c.amount_cents, 0))}
        </li>
      </Show>
    </ul>
  );

  const GroupHead = (p: { color: string; label: string; value: number; avg?: number }) => (
    <div class="mb-1 flex items-baseline gap-2">
      <span class="size-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} />
      <span class="text-sm font-semibold">{p.label}</span>
      <span class="num ml-auto text-sm font-semibold">{money0(p.value)}</span>
      <Show when={p.avg}>
        <span class="text-muted num text-xs">moy. {money0(p.avg!)}</span>
      </Show>
    </div>
  );

  return (
    <Card
      class="lg:col-span-3"
      title="Dépenses du mois"
      subtitle={`${money0(total())} au total`}
      actions={
        <div class="tabs tabs-box tabs-xs" role="radiogroup" aria-label="Vue des dépenses">
          <For each={views}>
            {(v) => (
              <button role="radio" aria-checked={store.categoryView() === v.v} class={`tab ${store.categoryView() === v.v ? "tab-active" : ""}`} onClick={() => store.setCategoryView(v.v)}>
                {v.label}
              </button>
            )}
          </For>
        </div>
      }
    >
      <Show when={spent().length} fallback={<Empty icon="lucide:receipt-text" title="Aucune dépense ce mois-ci" />}>
        <Switch>
          <Match when={store.categoryView() === "detail"}>
            <div class="flex flex-col gap-5">
              <Donut ariaLabel="Répartition des dépenses par catégorie" centerLabel="Dépenses" slices={detailSlices()} />
              <CategoryBars rows={props.s.by_category} total={total()} onOpen={props.onOpen} />
            </div>
          </Match>

          <Match when={store.categoryView() === "budget"}>
            <Show
              when={planned()}
              fallback={
                <Empty icon="lucide:calculator" title="Pas de budget actif">
                  Crée ton budget dans <A href="/budget" class="link">Budget</A> pour distinguer le prévu du non prévu.
                </Empty>
              }
            >
              {(pl) => (
                <div class="flex flex-col gap-5">
                  <Donut
                    ariaLabel="Dépenses prévues et non prévues"
                    centerLabel="Dépenses"
                    slices={[
                      { key: "p", label: "Prévu au budget", value: pl().sum, color: "var(--series-1)" },
                      { key: "n", label: "Non prévu", value: pl().rest, color: "var(--series-2)" },
                    ]}
                  />
                  <div class="grid gap-5 sm:grid-cols-2">
                    <div>
                      <GroupHead color="var(--series-1)" label="Prévu" value={pl().sum} />
                      <ul class="flex flex-col">
                        <For each={pl().lines.slice(0, 6)}>
                          {(x) => (
                            <li class="flex items-center gap-2.5 px-1.5 py-1">
                              <CategoryIcon category={x.line.category_id != null ? store.categoryById().get(x.line.category_id) : null} size="sm" />
                              <span class="min-w-0 flex-1 truncate text-sm">{x.line.name}</span>
                              <span class="num text-sm font-semibold">{money0(x.actual)}</span>
                              <span class="text-muted num text-xs">/ {money0(x.planned)}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                    <div>
                      <GroupHead color="var(--series-2)" label="Non prévu" value={pl().rest} />
                      <CatList rows={pl().unbudgeted.map((c) => ({ category_id: c.category_id, amount_cents: c.actual_cents, count: c.count, prev_cents: 0, avg_cents: c.detected_cents, budget_cents: null }))} />
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </Match>

          <Match when={store.categoryView() === "simple"}>
            <div class="flex flex-col gap-5">
              <Donut
                ariaLabel="Dépenses vitales et plaisir"
                centerLabel="Dépenses"
                slices={[
                  { key: "v", label: "Vital", value: natures().sum(natures().groups.vital), color: "var(--series-1)" },
                  { key: "p", label: "Plaisir", value: natures().sum(natures().groups.plaisir), color: "var(--series-2)" },
                  { key: "a", label: "Non défini", value: natures().sum(natures().groups.autre), color: "var(--ink-muted)" },
                ]}
              />
              <div class="grid gap-5 sm:grid-cols-2">
                <div>
                  <GroupHead color="var(--series-1)" label="Vital" value={natures().sum(natures().groups.vital)} avg={natures().avg(natures().groups.vital)} />
                  <CatList rows={natures().groups.vital} />
                </div>
                <div>
                  <GroupHead color="var(--series-2)" label="Plaisir" value={natures().sum(natures().groups.plaisir)} avg={natures().avg(natures().groups.plaisir)} />
                  <CatList rows={natures().groups.plaisir} />
                </div>
              </div>
              <Show when={natures().groups.autre.length}>
                <p class="text-muted text-xs">
                  {money0(natures().sum(natures().groups.autre))} sans nature (non classé ou catégorie sans nature) · à régler dans{" "}
                  <A href="/categories" class="link">Catégories</A>.
                </p>
              </Show>
            </div>
          </Match>
        </Switch>
      </Show>
    </Card>
  );
}
