import { A, useSearchParams } from "@solidjs/router";
import { createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js";
import { api, type Category, type RecurringItem, type Tx } from "../api";
import { YearView } from "../components/calendar/YearView";
import { BarList, type BarRow } from "../components/charts/BarList";
import { Card, CategoryIcon, Empty, Ico, Spinner } from "../components/ui";
import { dayLong, money, money0, monthLong, prettyMerchant } from "../format";
import { errorText, store } from "../store";

/**
 * Calendrier : les opérations du mois ou de l'année, jour par jour, avec les paiements
 * récurrents (passés et à venir). Tous les filtres vivent dans l'URL (partageables, retour arrière).
 */
type Params = {
  month?: string;
  day?: string;
  view?: string; // "grid" (défaut) | "matrix" | "year"
  kind?: string; // "expense" (défaut) | "income" | "all"
  cats?: string; // ids séparés par des virgules ; "none" = non classé
  account?: string;
  q?: string;
  min?: string; // euros
  rec?: string; // "only" | "hide"
  budget?: string; // "out"
  upcoming?: string; // "0" pour masquer les récurrents à venir
};

type Kind = "expense" | "income" | "all";
type Upcoming = { r: RecurringItem; day: string; late: boolean };

const WEEKDAYS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDay = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const thisMonth = () => ymd(new Date()).slice(0, 7);
const shiftMonth = (m: string, n: number) => {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const daysIn = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
/** Ajoute n mois en gardant le jour (31 → dernier jour du mois s'il est plus court). */
const addMonthsKeepDay = (d: Date, n: number, day: number) => {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return new Date(target.getFullYear(), target.getMonth(), Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
};

/** Toutes les opérations d'un mois (pages de 500). */
async function monthTx(month: string, budget?: string): Promise<Tx[]> {
  const out: Tx[] = [];
  for (;;) {
    const p = await api.transactions({ month, budget }, 500, out.length);
    out.push(...p.items);
    if (!p.items.length || out.length >= p.total) return out;
  }
}

const monthsInPeriod = (period: string) =>
  period.length === 4 ? Array.from({ length: 12 }, (_, i) => `${period}-${pad2(i + 1)}`) : [period];

/** Une année réutilise l'API mensuelle, avec trois requêtes simultanées au maximum. */
async function periodTx(period: string, budget?: string): Promise<Tx[]> {
  const months = monthsInPeriod(period);
  const results: Tx[][] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, months.length) }, async () => {
      while (next < months.length) {
        const index = next++;
        results[index] = await monthTx(months[index], budget);
      }
    }),
  );
  return results.flat();
}

/** Un récurrent « attrape » une opération : même marchand (détecté) ou motif contenu dans le libellé (manuel). */
const recurringMatcher = (items: RecurringItem[]) => {
  const byMerchant = new Map(items.filter((r) => r.manual_id == null).map((r) => [r.merchant, r]));
  const manual = items.filter((r) => r.manual_id != null && r.merchant.trim().length > 0);
  return (t: Tx): RecurringItem | null => {
    const hit = t.merchant ? byMerchant.get(t.merchant) : undefined;
    if (hit && (hit.kind === "expense") === t.amount_cents < 0) return hit;
    const text = `${t.label} ${t.counterparty ?? ""} ${t.merchant ?? ""}`.toUpperCase();
    return manual.find((r) => (r.kind === "expense") === t.amount_cents < 0 && text.includes(r.merchant.toUpperCase())) ?? null;
  };
};

/** Prochaines échéances d'un récurrent dans le mois affiché (à partir d'aujourd'hui ; en retard : le jour prévu). */
function occurrences(r: RecurringItem, month: string, today: string): Upcoming[] {
  if (r.status === "stopped" || !r.next_day) return [];
  const first = `${month}-01`;
  const last = `${month}-${pad2(daysIn(month))}`;
  const out: Upcoming[] = [];
  const start = parseDay(r.next_day);
  const dom = start.getDate();
  let d = start;
  for (let i = 0; i < 400 && ymd(d) <= last; i++) {
    const s = ymd(d);
    const late = s < today;
    if (s >= first && (s >= today || (late && i === 0))) out.push({ r, day: s, late });
    d =
      r.cadence === "weekly"
        ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)
        : addMonthsKeepDay(start, (i + 1) * (r.cadence === "monthly" ? 1 : r.cadence === "quarterly" ? 3 : 12), dom);
  }
  return out;
}

export default function CalendarPage() {
  const [params, setParams] = useSearchParams<Params>();
  const month = () => (params.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month) ? params.month : thisMonth());
  const kind = (): Kind => (params.kind === "income" || params.kind === "all" ? params.kind : "expense");
  const view = () => (params.view === "year" ? "year" : params.view === "matrix" ? "matrix" : "grid");
  const year = () => month().slice(0, 4);
  const period = createMemo(() => (view() === "year" ? year() : month()));
  const periodLabel = () => (view() === "year" ? year() : monthLong(month()));
  const visibleMonths = createMemo(() => monthsInPeriod(period()));
  const cats = createMemo(() => new Set((params.cats ?? "").split(",").filter(Boolean)));
  const today = ymd(new Date());

  const [txs] = createResource(
    () => ({ p: period(), v: store.version() }),
    async ({ p }) => ({ period: p, items: await periodTx(p) }),
  );
  const [outIds] = createResource(
    () => (params.budget === "out" ? { p: period(), v: store.version() } : false),
    async ({ p }) => ({ period: p, ids: new Set((await periodTx(p, "out")).map((t) => t.id)) }),
  );
  const currentTxs = () => !txs.error && txs.latest?.period === period() ? txs.latest.items : undefined;
  const currentOutIds = () => !outIds.error && outIds.latest?.period === period() ? outIds.latest.ids : undefined;
  const periodReady = () => currentTxs() !== undefined && (params.budget !== "out" || currentOutIds() !== undefined);
  const loadError = () => txs.error || (params.budget === "out" && outIds.error);
  const [recurring] = createResource(store.version, () => api.recurring());
  const [accounts] = createResource(() => api.accounts());
  const [summary] = createResource(store.version, () => api.summary());

  const recOf = createMemo(() => recurringMatcher(recurring.latest?.items ?? []));
  const catKey = (id: number | null) => (id == null ? "none" : String(id));
  const minCents = () => {
    const v = Number((params.min ?? "").replace(",", "."));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
  };
  const query = () => (params.q ?? "").trim().toLowerCase();

  const kindOk = (k: string) =>
    kind() === "all" ? !(k === "transfer" && store.hideTransfers()) : k === kind();

  // Opérations après filtres (les exclues ne comptent jamais, comme partout ailleurs).
  const filtered = createMemo(() => {
    const all = (currentTxs() ?? []).filter((t) => t.day.startsWith(period()));
    const out = params.budget === "out" ? (currentOutIds() ?? new Set<number>()) : null;
    const q = query();
    return all.filter(
      (t) =>
        !t.excluded &&
        kindOk(t.kind) &&
        (!cats().size || cats().has(catKey(t.category_id))) &&
        (!params.account || t.account_id === params.account) &&
        (!q || `${t.label} ${t.merchant ?? ""} ${t.counterparty ?? ""}`.toLowerCase().includes(q)) &&
        Math.abs(t.amount_cents) >= minCents() &&
        (params.rec !== "only" || recOf()(t) != null) &&
        (params.rec !== "hide" || recOf()(t) == null) &&
        (!out || out.has(t.id)),
    );
  });

  // Échéances à venir : mêmes filtres quand ils ont un sens pour un récurrent.
  const upcoming = createMemo((): Upcoming[] => {
    if (params.upcoming === "0" || params.rec === "hide" || params.budget === "out") return [];
    const months = visibleMonths().filter((m) => m >= thisMonth());
    const q = query();
    return (recurring.latest?.items ?? [])
      .filter(
        (r) =>
          kindOk(r.kind) &&
          (!cats().size || cats().has(catKey(r.category_id))) &&
          (!q || `${r.name} ${r.merchant} ${r.label}`.toLowerCase().includes(q)) &&
          r.amount_cents >= minCents(),
      )
      .flatMap((r) => months.flatMap((m) => occurrences(r, m, today)));
  });

  /** Valeur d'une opération dans la vue : dépense positive en vue dépenses, revenus positifs en vue revenus, signé en vue tout. */
  const value = (t: Tx) => (kind() === "expense" ? -t.amount_cents : kind() === "income" ? t.amount_cents : t.amount_cents);

  type Day = { day: string; total: number; expense: number; income: number; items: Tx[]; byCat: Map<string, number>; upcoming: Upcoming[] };
  const days = createMemo(() => {
    const map = new Map<string, Day>();
    for (const month of visibleMonths()) {
      for (let i = 1; i <= daysIn(month); i++) {
        const d = `${month}-${pad2(i)}`;
        map.set(d, { day: d, total: 0, expense: 0, income: 0, items: [], byCat: new Map(), upcoming: [] });
      }
    }
    for (const t of filtered()) {
      const d = map.get(t.day);
      if (!d) continue;
      d.items.push(t);
      d.total += value(t);
      if (t.kind === "expense") d.expense -= t.amount_cents;
      if (t.kind === "income") d.income += t.amount_cents;
      const k = catKey(t.category_id);
      d.byCat.set(k, (d.byCat.get(k) ?? 0) + Math.abs(t.amount_cents));
    }
    for (const u of upcoming()) map.get(u.day)?.upcoming.push(u);
    return [...map.values()];
  });

  const dayValue = (d: Day) => (kind() === "all" ? d.expense : d.total);
  const monthTotal = () => filtered().reduce((a, t) => a + value(t), 0);
  const upcomingTotal = () => upcoming().reduce((a, u) => a + u.r.amount_cents, 0);
  const maxDay = createMemo(() => Math.max(1, ...days().map((d) => Math.abs(kind() === "all" ? d.expense : d.total))));
  const busiest = createMemo(() => days().reduce<Day | null>((a, d) => (dayValue(d) > (a ? dayValue(a) : 0) ? d : a), null));
  const elapsed = createMemo(() => days().filter((d) => d.day <= today).length);
  const recurringPaid = createMemo(() => filtered().filter((t) => recOf()(t) != null));

  const catLabel = (k: string) => (k === "none" ? "Non classé" : (store.categoryById().get(Number(k))?.name ?? "?"));
  const catObj = (k: string): Category | null => (k === "none" ? null : (store.categoryById().get(Number(k)) ?? null));

  const byCategory = createMemo((): BarRow[] => {
    const acc = new Map<string, { v: number; n: number }>();
    for (const t of filtered()) {
      const k = catKey(t.category_id);
      const a = acc.get(k) ?? { v: 0, n: 0 };
      a.v += kind() === "all" ? Math.abs(t.amount_cents) : value(t);
      a.n += 1;
      acc.set(k, a);
    }
    return [...acc]
      .filter(([, a]) => a.v > 0)
      .sort((a, b) => b[1].v - a[1].v)
      .map(([k, a]) => ({ key: k, category: catObj(k), label: catLabel(k), value: a.v, count: a.n, onClick: () => toggleCat(k) }));
  });

  const toggleCat = (k: string) => {
    const s = new Set(cats());
    if (s.has(k)) s.delete(k);
    else s.add(k);
    setParams({ cats: [...s].join(",") || undefined });
  };

  const selected = () => (params.day?.startsWith(month()) ? days().find((d) => d.day === params.day) : undefined);
  const selectDay = (d: string) => setParams({ day: params.day === d ? undefined : d });
  const goMonth = (m: string) => setParams({ month: m === thisMonth() ? undefined : m, day: undefined });
  const movePeriod = (direction: number) => goMonth(shiftMonth(month(), direction * (view() === "year" ? 12 : 1)));
  const openMonth = (m: string) => setParams({ month: m === thisMonth() ? undefined : m, day: undefined, view: undefined });
  const openDay = (day: string) =>
    setParams({ month: day.slice(0, 7) === thisMonth() ? undefined : day.slice(0, 7), day, view: view() === "year" ? undefined : params.view });

  let navigation: HTMLDivElement | undefined;
  onMount(() => {
    if (!navigation) return;
    const element = navigation;
    let accumulated = 0;
    let locked = false;
    let reset: number | undefined;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, select, textarea, [contenteditable], [role=radiogroup]")) return;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      // La matrice garde son défilement horizontal ; l'année garde son défilement vertical.
      if (view() === "matrix" && horizontal) return;
      if (view() === "year" && !horizontal && !target?.closest("header")) return;
      const delta = (horizontal ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (!delta) return;
      event.preventDefault();
      window.clearTimeout(reset);
      reset = window.setTimeout(() => { accumulated = 0; locked = false; }, 180);
      if (locked) return;
      if (Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
      accumulated += delta;
      if (Math.abs(accumulated) >= 40) {
        movePeriod(Math.sign(accumulated));
        locked = true;
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => {
      element.removeEventListener("wheel", wheel);
      window.clearTimeout(reset);
    });
  });

  let debounce: number | undefined;
  const onSearch = (v: string) => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => setParams({ q: v || undefined }), 250);
  };
  onCleanup(() => window.clearTimeout(debounce));

  const filtersActive = () => !!(params.cats || params.account || params.q || params.min || params.rec || params.budget || params.kind);
  const clearFilters = () =>
    setParams({ cats: undefined, account: undefined, q: undefined, min: undefined, rec: undefined, budget: undefined, kind: undefined });

  // Cases du mois, semaine commençant le lundi.
  const cells = createMemo(() => {
    const lead = (parseDay(`${month()}-01`).getDay() + 6) % 7;
    const out: (Day | null)[] = [...Array(lead).fill(null), ...days()];
    while (out.length % 7) out.push(null);
    return out;
  });

  const months = createMemo(() => {
    const s = new Set(summary.latest?.months ?? []);
    s.add(thisMonth());
    s.add(month());
    return [...s].sort().reverse();
  });
  const years = createMemo(() => [...new Set(months().map((m) => m.slice(0, 4)))].sort().reverse());

  const tint = (v: number) => {
    if (v <= 0) return undefined;
    const share = 6 + 30 * Math.sqrt(Math.min(v / maxDay(), 1));
    return `color-mix(in oklab, var(--series-1) ${Math.round(share)}%, var(--color-base-100))`;
  };

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Calendrier</h1>
          <p class="text-muted text-sm">Tes opérations jour par jour, par catégorie, avec les paiements récurrents passés et à venir.</p>
        </div>
        <div class="flex items-center gap-2">
          <div class="join">
            <button class="btn btn-sm join-item" onClick={() => movePeriod(-1)} aria-label={view() === "year" ? "Année précédente" : "Mois précédent"}>
              <Ico icon="lucide:chevron-left" />
            </button>
            <Show when={view() === "year"} fallback={
              <select class="select select-sm join-item w-44" value={month()} onChange={(e) => goMonth(e.currentTarget.value)} aria-label="Mois">
                <For each={months()}>{(m) => <option value={m}>{monthLong(m)}</option>}</For>
              </select>
            }>
              <select class="select select-sm join-item w-44" value={year()} onChange={(e) => goMonth(`${e.currentTarget.value}-${month().slice(5, 7)}`)} aria-label="Année">
                <For each={years()}>{(y) => <option value={y}>{y}</option>}</For>
              </select>
            </Show>
            <button class="btn btn-sm join-item" onClick={() => movePeriod(1)} aria-label={view() === "year" ? "Année suivante" : "Mois suivant"}>
              <Ico icon="lucide:chevron-right" />
            </button>
          </div>
          <Show when={period() !== (view() === "year" ? thisMonth().slice(0, 4) : thisMonth())}>
            <button class="btn btn-sm btn-ghost" onClick={() => setParams({ month: undefined, day: view() === "year" ? undefined : today })}>
              Aujourd'hui
            </button>
          </Show>
        </div>
      </div>

      {/* Filtres : une rangée au-dessus de tout ce qu'ils pilotent */}
      <div class="flex flex-wrap items-center gap-2">
        <label class="input input-sm w-full sm:w-56">
          <Ico icon="lucide:search" class="text-muted" />
          <input type="search" placeholder="Libellé, marchand…" value={params.q ?? ""} onInput={(e) => onSearch(e.currentTarget.value)} />
        </label>
        <div class="tabs tabs-box tabs-sm" role="radiogroup" aria-label="Type">
          <For each={[{ v: "expense", l: "Dépenses" }, { v: "income", l: "Revenus" }, { v: "all", l: "Tout" }] as const}>
            {(k) => (
              <button role="radio" aria-checked={kind() === k.v} class={`tab ${kind() === k.v ? "tab-active" : ""}`} onClick={() => setParams({ kind: k.v === "expense" ? undefined : k.v })}>
                {k.l}
              </button>
            )}
          </For>
        </div>
        <CategoryFilter selected={cats()} kind={kind()} onToggle={toggleCat} onClear={() => setParams({ cats: undefined })} />
        <Show when={(accounts.latest?.length ?? 0) > 1}>
          <select class="select select-sm w-auto" value={params.account ?? ""} onChange={(e) => setParams({ account: e.currentTarget.value || undefined })} aria-label="Compte">
            <option value="">Tous les comptes</option>
            <For each={accounts.latest}>{(a) => <option value={a.id}>{a.bank}{a.product ? ` · ${a.product}` : ""}</option>}</For>
          </select>
        </Show>
        <select class="select select-sm w-auto" value={params.rec ?? ""} onChange={(e) => setParams({ rec: e.currentTarget.value || undefined })} aria-label="Récurrents">
          <option value="">Récurrents et ponctuels</option>
          <option value="only">Récurrents seulement</option>
          <option value="hide">Sans les récurrents</option>
        </select>
        <label class="input input-sm w-32" title="Montant minimum">
          <span class="text-muted text-xs">≥</span>
          <input type="number" min="0" step="1" inputmode="decimal" placeholder="0" value={params.min ?? ""} onChange={(e) => setParams({ min: e.currentTarget.value || undefined })} aria-label="Montant minimum en euros" />
          <span class="text-muted text-xs">€</span>
        </label>
        <button
          class={`btn btn-sm ${params.budget === "out" ? "btn-active" : ""}`}
          onClick={() => setParams({ budget: params.budget === "out" ? undefined : "out" })}
          aria-pressed={params.budget === "out"}
          title="Dépenses qu'aucun poste du budget actif ne couvre"
        >
          <Ico icon="lucide:wallet" /> Hors budget
        </button>
        <label class="label cursor-pointer gap-2 text-sm" title={view() === "year" ? "Paiements récurrents attendus d'ici la fin de l'année" : "Paiements récurrents attendus d'ici la fin du mois"}>
          <input type="checkbox" class="toggle toggle-sm" checked={params.upcoming !== "0"} onChange={(e) => setParams({ upcoming: e.currentTarget.checked ? undefined : "0" })} />
          À venir
        </label>
        <Show when={filtersActive()}>
          <button class="btn btn-ghost btn-sm" onClick={clearFilters}>
            <Ico icon="lucide:x" /> Effacer les filtres
          </button>
        </Show>
      </div>

      <Show when={loadError()}>
        <div role="alert" class="alert alert-error">
          <Ico icon="lucide:circle-alert" /> {errorText(loadError())}
        </div>
      </Show>

      {/* Synthèse de la période (filtres appliqués) */}
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label={kind() === "income" ? "Reçu" : kind() === "all" ? "Solde" : "Dépensé"}
          value={periodReady() ? money0(monthTotal()) : "—"}
          note={periodReady() ? `${filtered().length} opération${filtered().length > 1 ? "s" : ""}` : loadError() ? "données indisponibles" : "chargement…"}
        />
        <Stat
          label="Moyenne par jour"
          value={periodReady() && elapsed() ? money0(monthTotal() / elapsed()) : "—"}
          note={elapsed() ? `sur ${elapsed()} jour${elapsed() > 1 ? "s" : ""}` : view() === "year" ? "année à venir" : "mois à venir"}
        />
        <Stat
          label="Jour le plus chargé"
          value={busiest() ? money0(dayValue(busiest()!)) : "—"}
          note={busiest() ? dayLong(busiest()!.day) : "aucune opération"}
          onClick={busiest() ? () => openDay(busiest()!.day) : undefined}
        />
        <Stat
          label="Récurrents"
          value={periodReady() ? money0(recurringPaid().reduce((a, t) => a + Math.abs(t.amount_cents), 0)) : "—"}
          note={
            `${recurringPaid().length} payé${recurringPaid().length > 1 ? "s" : ""}` +
            (upcoming().length ? ` · ${money0(upcomingTotal())} encore attendus` : view() === "year" ? " cette année" : " ce mois-ci")
          }
        />
      </div>

      <div class={`grid grid-cols-1 gap-5 ${view() === "year" ? "" : "xl:grid-cols-[minmax(0,1fr)_22rem]"}`}>
        <div
          ref={navigation}
          tabIndex={0}
          role="group"
          aria-label="Navigation du calendrier"
          aria-busy={txs.loading || outIds.loading}
          class="min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              movePeriod(event.key === "ArrowLeft" ? -1 : 1);
            }
          }}
        >
        <Card
          class={`!p-0 [&>header]:flex-wrap [&>header]:px-4 [&>header]:pt-4 sm:[&>header]:px-5 ${txs.loading || outIds.loading ? "refetching" : ""}`}
          title={<span aria-live="polite">{periodLabel()}</span>}
          subtitle={view() === "year" ? "Clique sur un mois pour l'ouvrir · défile horizontalement pour changer d'année" : view() === "grid" ? "Molette : changer de mois · clique sur un jour pour le détail" : "Molette : changer de mois · défile horizontalement pour parcourir les jours"}
          actions={
            <div class="tabs tabs-box tabs-xs" role="radiogroup" aria-label="Vue">
              <button role="radio" aria-checked={view() === "grid"} class={`tab gap-1 ${view() === "grid" ? "tab-active" : ""}`} onClick={() => setParams({ view: undefined })}>
                <Ico icon="lucide:calendar-days" /> Mois
              </button>
              <button role="radio" aria-checked={view() === "year"} class={`tab gap-1 ${view() === "year" ? "tab-active" : ""}`} onClick={() => setParams({ view: "year", day: undefined })}>
                <Ico icon="lucide:calendar-range" /> Année
              </button>
              <button role="radio" aria-checked={view() === "matrix"} class={`tab gap-1 ${view() === "matrix" ? "tab-active" : ""}`} onClick={() => setParams({ view: "matrix" })}>
                <Ico icon="lucide:grid-3x3" /> Catégories
              </button>
            </div>
          }
        >
          <Show when={currentTxs()} fallback={
            <Show when={txs.loading} fallback={<div class="py-12"><Empty icon="lucide:calendar-x" title="Données indisponibles pour cette période" /></div>}>
              <div class="flex justify-center py-24"><Spinner class="loading-md" /></div>
            </Show>
          }>
            <Show when={view() !== "year"} fallback={
              <YearView
                year={year()}
                today={today}
                days={days().map((d) => ({ day: d.day, value: dayValue(d), total: d.total, count: d.items.length, upcoming: d.upcoming.length }))}
                onMonth={openMonth}
              />
            }>
            <Show
              when={view() === "grid"}
              fallback={<CategoryMatrix month={month()} days={days()} order={byCategory().map((r) => r.key)} label={catLabel} category={catObj} selected={params.day} onSelect={(d) => setParams({ day: d })} />}
            >
              <div class="px-2 pb-3 sm:px-4 sm:pb-4">
                <div class="text-muted grid grid-cols-7 gap-1 pb-1 text-center text-[11px] font-medium">
                  <For each={WEEKDAYS}>{(w) => <div class="min-w-0 truncate">{w}</div>}</For>
                </div>
                <div class="grid grid-cols-7 gap-1">
                  <For each={cells()}>
                    {(d) => (
                      <Show when={d} fallback={<div class="min-w-0" />}>
                        <DayCell
                          d={d!}
                          kind={kind()}
                          today={d!.day === today}
                          future={d!.day > today}
                          selected={params.day === d!.day}
                          tint={tint(dayValue(d!))}
                          label={catLabel}
                          category={catObj}
                          isRecurring={(t) => recOf()(t) != null}
                          onClick={() => selectDay(d!.day)}
                        />
                      </Show>
                    )}
                  </For>
                </div>
                <div class="text-muted mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  <span class="inline-flex items-center gap-1.5">
                    <span class="h-2 w-16 rounded-full" style={{ background: "linear-gradient(90deg, var(--color-base-100), color-mix(in oklab, var(--series-1) 36%, var(--color-base-100)))" }} />
                    plus foncé = plus dépensé
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <Ico icon="lucide:repeat" /> récurrent
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <span class="border-base-content/40 size-2.5 rounded-[3px] border border-dashed" /> attendu
                  </span>
                </div>
              </div>
            </Show>
            </Show>
          </Show>
        </Card>
        </div>

        <div class={view() === "year" ? `grid grid-cols-1 gap-5 ${upcoming().length ? "lg:grid-cols-2" : ""}` : "flex flex-col gap-5"}>
          <Show
            when={selected()}
            fallback={
              <Card title="Par catégorie" subtitle={`${periodLabel()} · clique pour filtrer`}>
                <Show when={byCategory().length} fallback={<Empty icon="lucide:calendar-x" title="Rien sur cette période avec ces filtres" />}>
                  <BarList rows={byCategory()} total={byCategory().reduce((a, r) => a + r.value, 0)} hint="Clique sur une catégorie pour filtrer le calendrier" />
                </Show>
              </Card>
            }
          >
            <DayPanel
              d={selected()!}
              kind={kind()}
              isRecurring={(t) => recOf()(t)}
              onClose={() => setParams({ day: undefined })}
            />
          </Show>

          <Show when={upcoming().length}>
            <Card title={view() === "year" ? "À venir cette année" : "À venir ce mois-ci"} subtitle="Récurrents attendus d'après leur rythme habituel">
              <ul class="flex flex-col">
                <For each={[...upcoming()].sort((a, b) => a.day.localeCompare(b.day))}>
                  {(u) => (
                    <li>
                      <button class="hover:bg-base-200 flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left" onClick={() => openDay(u.day)}>
                        <CategoryIcon category={u.r.category_id != null ? store.categoryById().get(u.r.category_id) : null} size="sm" />
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-sm">{u.r.name}</div>
                          <div class={`text-xs ${u.late ? "text-warning" : "text-muted"}`}>
                            {u.late ? "en retard · prévu le " : ""}
                            {parseDay(u.day).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}
                          </div>
                        </div>
                        <span class={`num text-sm font-semibold ${u.r.kind === "income" ? "text-gain" : ""}`}>{money0(u.r.amount_cents)}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Card>
          </Show>
        </div>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; note: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      class={`card-surface flex flex-col gap-1.5 p-4 text-left sm:p-5 ${props.onClick ? "hover:bg-base-200/40" : "cursor-default"}`}
      onClick={() => props.onClick?.()}
      disabled={!props.onClick}
    >
      <span class="text-ink-2 text-sm">{props.label}</span>
      <span class="num text-xl leading-none font-semibold sm:text-2xl">{props.value}</span>
      <span class="text-muted truncate text-xs first-letter:uppercase">{props.note}</span>
    </button>
  );
}

function DayCell(props: {
  d: { day: string; total: number; expense: number; income: number; items: Tx[]; byCat: Map<string, number>; upcoming: Upcoming[] };
  kind: Kind;
  today: boolean;
  future: boolean;
  selected: boolean;
  tint?: string;
  label: (k: string) => string;
  category: (k: string) => Category | null;
  isRecurring: (t: Tx) => boolean;
  onClick: () => void;
}) {
  const cats = () => [...props.d.byCat].sort((a, b) => b[1] - a[1]);
  const nRec = () => props.d.items.filter(props.isRecurring).length;
  const dayNum = () => Number(props.d.day.slice(8, 10));
  const aria = () =>
    `${dayLong(props.d.day)} : ${props.d.items.length} opération${props.d.items.length > 1 ? "s" : ""}` +
    (props.d.items.length ? `, ${money(props.kind === "all" ? props.d.expense : props.d.total)}` : "") +
    (props.d.upcoming.length ? `, ${props.d.upcoming.length} attendu${props.d.upcoming.length > 1 ? "s" : ""}` : "");
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={aria()}
      aria-pressed={props.selected}
      class={`rounded-field flex min-h-16 min-w-0 flex-col gap-1 overflow-hidden border p-1 text-left transition-colors sm:min-h-24 sm:p-1.5 ${
        props.selected ? "border-primary ring-primary ring-1" : "border-[var(--hairline)] hover:border-base-content/30"
      } ${props.future && !props.d.items.length ? "opacity-80" : ""}`}
      style={{ background: props.tint ?? "var(--color-base-100)" }}
    >
      <div class="flex items-center justify-between gap-1">
        <span
          class={`num inline-flex size-5 items-center justify-center rounded-full text-[11px] ${
            props.today ? "bg-primary text-primary-content font-semibold" : "text-ink-2"
          }`}
        >
          {dayNum()}
        </span>
        <Show when={nRec()}>
          <span class="text-muted hidden items-center text-[10px] sm:inline-flex" title={`${nRec()} paiement(s) récurrent(s)`}>
            <Ico icon="lucide:repeat" />
            <Show when={nRec() > 1}>{nRec()}</Show>
          </span>
        </Show>
      </div>
      <Show when={props.d.items.length}>
        <div class="num truncate text-[11px] leading-tight font-semibold sm:text-sm">
          {props.kind === "all" ? (
            <>
              <Show when={props.d.expense}>{money0(props.d.expense)}</Show>
              <Show when={props.d.income}>
                <span class="text-gain block text-[11px] font-medium">+{money0(props.d.income)}</span>
              </Show>
            </>
          ) : (
            money0(props.d.total)
          )}
        </div>
      </Show>
      {/* Catégories du jour (bureau) */}
      <div class="hidden min-w-0 flex-col gap-0.5 sm:flex">
        <For each={cats().slice(0, 2)}>
          {([k, v]) => (
            <span class="text-ink-2 flex min-w-0 items-center gap-1 text-[11px] leading-tight" title={`${props.label(k)} : ${money(v)}`}>
              <Ico icon={props.category(k)?.icon ?? "lucide:circle-help"} class="shrink-0" />
              <span class="truncate">{props.label(k)}</span>
            </span>
          )}
        </For>
        <Show when={cats().length > 2}>
          <span class="text-muted text-[10px]">+{cats().length - 2} autre{cats().length > 3 ? "s" : ""}</span>
        </Show>
      </div>
      <For each={props.d.upcoming.slice(0, 2)}>
        {(u) => (
          <span
            class={`hidden min-w-0 items-center gap-1 rounded-[4px] border border-dashed px-1 text-[10px] leading-4 sm:flex ${u.late ? "border-warning text-warning" : "border-base-content/30 text-ink-2"}`}
            title={`${u.r.name} attendu : ${money(u.r.amount_cents)}`}
          >
            <span class="truncate">{u.r.name}</span>
            <span class="num ml-auto shrink-0">{money0(u.r.amount_cents)}</span>
          </span>
        )}
      </For>
      <Show when={props.d.upcoming.length}>
        <span class="border-base-content/40 mt-auto size-2 rounded-full border border-dashed sm:hidden" />
      </Show>
    </button>
  );
}

function DayPanel(props: {
  d: { day: string; total: number; expense: number; income: number; items: Tx[]; upcoming: Upcoming[] };
  kind: Kind;
  isRecurring: (t: Tx) => RecurringItem | null;
  onClose: () => void;
}) {
  const items = () => [...props.d.items].sort((a, b) => a.amount_cents - b.amount_cents);
  return (
    <Card
      title={<span class="first-letter:uppercase">{dayLong(props.d.day)}</span>}
      subtitle={
        props.d.items.length
          ? `${props.d.items.length} opération${props.d.items.length > 1 ? "s" : ""}` +
            (props.d.expense ? ` · ${money(props.d.expense)} dépensés` : "") +
            (props.d.income ? ` · ${money(props.d.income)} reçus` : "")
          : "Aucune opération avec ces filtres"
      }
      actions={
        <button class="btn btn-ghost btn-xs btn-square" onClick={props.onClose} aria-label="Fermer le détail du jour">
          <Ico icon="lucide:x" />
        </button>
      }
    >
      <ul class="flex flex-col">
        <For each={items()}>
          {(t) => {
            const rec = () => props.isRecurring(t);
            const cat = () => (t.category_id != null ? store.categoryById().get(t.category_id) : null);
            return (
              <li class="flex items-center gap-3 py-1.5">
                <CategoryIcon category={cat()} size="sm" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-sm" title={t.label}>
                      {t.merchant ? prettyMerchant(t.merchant) : t.label}
                    </span>
                    <Show when={rec()}>
                      <span class="badge badge-ghost badge-xs shrink-0 gap-1" title={`Récurrent : ${rec()!.name}`}>
                        <Ico icon="lucide:repeat" /> récurrent
                      </span>
                    </Show>
                  </div>
                  <div class="text-muted truncate text-xs">
                    {cat()?.name ?? "Non classé"} · {t.bank}
                  </div>
                </div>
                <span class={`num text-sm font-semibold ${t.kind === "income" ? "text-gain" : t.kind === "transfer" ? "text-muted" : ""}`}>
                  {t.amount_cents > 0 ? "+" : "−"}
                  {money(Math.abs(t.amount_cents), t.currency).replace("-", "")}
                </span>
              </li>
            );
          }}
        </For>
        <For each={props.d.upcoming}>
          {(u) => (
            <li class="flex items-center gap-3 py-1.5 opacity-80">
              <span class="border-base-content/30 text-muted inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-dashed">
                <Ico icon="lucide:clock" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm">{u.r.name}</div>
                <div class={`text-xs ${u.late ? "text-warning" : "text-muted"}`}>{u.late ? "en retard" : "attendu"} · récurrent</div>
              </div>
              <span class="num text-ink-2 text-sm">{money0(u.r.amount_cents)}</span>
            </li>
          )}
        </For>
      </ul>
      <A href={`/operations?month=${props.d.day.slice(0, 7)}`} class="btn btn-ghost btn-xs mt-2">
        Toutes les opérations du mois <Ico icon="lucide:arrow-right" />
      </A>
    </Card>
  );
}

/** Sélecteur multiple de catégories (menu déroulant à cases à cocher). */
function CategoryFilter(props: { selected: Set<string>; kind: Kind; onToggle: (k: string) => void; onClear: () => void }) {
  const list = () => store.categories().filter((c) => props.kind === "all" || c.kind === props.kind);
  const label = () => {
    const n = props.selected.size;
    if (!n) return "Toutes catégories";
    if (n === 1) {
      const k = [...props.selected][0];
      return k === "none" ? "Non classé" : (store.categoryById().get(Number(k))?.name ?? "1 catégorie");
    }
    return `${n} catégories`;
  };
  return (
    <details class="dropdown">
      <summary class={`btn btn-sm ${props.selected.size ? "btn-active" : ""} font-normal`}>
        <Ico icon="lucide:tags" /> {label()} <Ico icon="lucide:chevron-down" class="text-muted" />
      </summary>
      <div class="dropdown-content card-surface z-20 mt-1 flex max-h-80 w-64 flex-col overflow-y-auto p-1 shadow-lg">
        <Show when={props.selected.size}>
          <button class="btn btn-ghost btn-xs justify-start" onClick={props.onClear}>
            <Ico icon="lucide:x" /> Tout désélectionner
          </button>
        </Show>
        <label class="hover:bg-base-200 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
          <input type="checkbox" class="checkbox checkbox-xs" checked={props.selected.has("none")} onChange={() => props.onToggle("none")} />
          <span class="text-muted">Non classé</span>
        </label>
        <For each={list()}>
          {(c) => (
            <label class="hover:bg-base-200 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
              <input type="checkbox" class="checkbox checkbox-xs" checked={props.selected.has(String(c.id))} onChange={() => props.onToggle(String(c.id))} />
              <Ico icon={c.icon} class="text-ink-2 shrink-0" />
              <span class="truncate">{c.name}</span>
            </label>
          )}
        </For>
      </div>
    </details>
  );
}

/** Catégories × jours du mois : une teinte, plus c'est foncé plus c'est élevé. */
function CategoryMatrix(props: {
  month: string;
  days: { day: string; byCat: Map<string, number> }[];
  order: string[];
  label: (k: string) => string;
  category: (k: string) => Category | null;
  selected?: string;
  onSelect: (day: string) => void;
}) {
  const max = createMemo(() => Math.max(1, ...props.days.flatMap((d) => [...d.byCat.values()])));
  const fill = (v: number) =>
    v <= 0 ? "var(--color-base-200)" : `color-mix(in oklab, var(--series-1) ${Math.round((0.14 + 0.86 * Math.sqrt(v / max())) * 100)}%, var(--color-base-100))`;
  const total = (k: string) => props.days.reduce((a, d) => a + (d.byCat.get(k) ?? 0), 0);
  return (
    <Show when={props.order.length} fallback={<Empty icon="lucide:grid-3x3" title="Rien à afficher avec ces filtres" />}>
      <div class="overflow-x-auto px-2 pb-4 sm:px-4">
        <table class="w-full border-separate" style={{ "border-spacing": "2px" }}>
          <thead>
            <tr>
              <th class="bg-base-100 sticky left-0 z-[1] w-36 min-w-32" />
              <For each={props.days}>
                {(d) => {
                  const wd = parseDay(d.day).getDay();
                  return (
                    <th class={`num min-w-[14px] pb-1 text-center text-[10px] font-medium ${wd === 0 || wd === 6 ? "text-ink-2" : "text-muted"}`}>
                      {Number(d.day.slice(8, 10))}
                    </th>
                  );
                }}
              </For>
              <th class="text-muted px-2 pb-1 text-right text-[11px] font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.order}>
              {(k) => (
                <tr>
                  <th scope="row" class="bg-base-100 sticky left-0 z-[1] pr-2 text-left font-normal">
                    <span class="flex items-center gap-2">
                      <CategoryIcon category={props.category(k)} size="sm" />
                      <span class="max-w-28 truncate text-sm">{props.label(k)}</span>
                    </span>
                  </th>
                  <For each={props.days}>
                    {(d) => {
                      const v = () => d.byCat.get(k) ?? 0;
                      return (
                        <td class="p-0">
                          <button
                            type="button"
                            class={`block h-7 w-full min-w-[12px] rounded-[4px] ${props.selected === d.day ? "ring-primary ring-2" : ""}`}
                            style={{ background: fill(v()) }}
                            title={`${props.label(k)} · ${dayLong(d.day)} : ${money(v())}`}
                            aria-label={`${props.label(k)}, ${dayLong(d.day)} : ${money(v())}`}
                            onClick={() => props.onSelect(d.day)}
                          />
                        </td>
                      );
                    }}
                  </For>
                  <td class="num px-2 text-right text-sm font-semibold whitespace-nowrap">{money0(total(k))}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
