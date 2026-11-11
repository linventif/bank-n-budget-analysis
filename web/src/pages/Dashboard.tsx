import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createMemo, createResource, For, Show } from "solid-js";
import { api, type CatAmount, type Summary } from "../api";
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
              <Budgets class="lg:col-span-2" rows={s()!.by_category} isCurrent={s()!.is_current_month} />
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
              subtitle="Abonnements et prélèvements détectés automatiquement"
              actions={
                <Show when={recurring.latest?.items.length}>
                  <span class="text-muted text-sm">
                    <span class="num text-base-content font-semibold">{money(recurring.latest!.monthly_total_cents)}</span> / mois
                  </span>
                </Show>
              }
            >
              <Show
                when={recurring.latest?.items.length}
                fallback={<Empty icon="lucide:repeat" title="Aucun paiement récurrent détecté">Il faut au moins 3 mois d'historique.</Empty>}
              >
                <ul class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  <For each={recurring.latest!.items}>
                    {(r) => {
                      const late = () => r.next_day != null && r.next_day < new Date().toISOString().slice(0, 10);
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

function Budgets(props: { rows: CatAmount[]; isCurrent: boolean; class?: string }) {
  const budgeted = () => props.rows.filter((r) => r.budget_cents != null && r.category_id != null);
  const dayRatio = () => {
    const d = new Date();
    return d.getDate() / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  };
  return (
    <Card class={props.class} title="Budgets" subtitle={props.isCurrent ? "Consommé à ce jour" : "Consommé sur le mois"}>
      <Show
        when={budgeted().length}
        fallback={
          <Empty icon="lucide:target" title="Aucun budget défini">
            Fixe un plafond mensuel par catégorie dans <A href="/categories" class="link">Catégories</A>.
          </Empty>
        }
      >
        <ul class="flex flex-col gap-3.5">
          <For each={budgeted()}>
            {(r) => {
              const cat = () => store.categoryById().get(r.category_id!);
              const ratio = () => r.amount_cents / r.budget_cents!;
              // Sévérité : dépassé > en avance sur le rythme du mois > dans les clous.
              const level = () => (ratio() > 1 ? "over" : props.isCurrent && ratio() > dayRatio() + 0.15 && ratio() > 0.75 ? "ahead" : "ok");
              const fill = () => ({ over: "var(--color-error)", ahead: "var(--color-warning)", ok: "var(--series-1)" })[level()];
              return (
                <li>
                  <div class="mb-1.5 flex items-center gap-2.5">
                    <CategoryIcon category={cat()} size="sm" />
                    <span class="min-w-0 flex-1 truncate text-sm">{cat()?.name}</span>
                    <span class="num text-sm">
                      <span class="font-semibold">{money0(r.amount_cents)}</span>
                      <span class="text-muted"> / {money0(r.budget_cents!)}</span>
                    </span>
                  </div>
                  <div
                    class="h-2 overflow-hidden rounded-full"
                    style={{ background: "color-mix(in oklab, var(--series-1) 16%, var(--color-base-100))" }}
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={r.budget_cents!}
                    aria-valuenow={r.amount_cents}
                    aria-label={`${cat()?.name} : ${money0(r.amount_cents)} sur ${money0(r.budget_cents!)}`}
                  >
                    <div class="h-full rounded-full" style={{ width: `${Math.min(ratio(), 1) * 100}%`, background: fill() }} />
                  </div>
                  <Show when={level() !== "ok"}>
                    <div class={`mt-1 flex items-center gap-1 text-xs ${level() === "over" ? "text-error" : "text-ink-2"}`}>
                      <Ico icon={level() === "over" ? "lucide:circle-alert" : "lucide:clock"} />
                      {level() === "over"
                        ? `Dépassé de ${money0(r.amount_cents - r.budget_cents!)}`
                        : `${percent(ratio())} du budget consommé, en avance sur le mois`}
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
