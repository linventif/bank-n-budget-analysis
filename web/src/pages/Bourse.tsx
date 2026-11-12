import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api, type MarketWatch } from "../api";
import { parseEuros } from "../budget";
import { PriceChart } from "../components/charts/PriceChart";
import { Card, Empty, Ico, IconButton, Spinner } from "../components/ui";
import { dayLabel, money0, monthShortYear, percent, relative } from "../format";
import { errorText, store } from "../store";

const RANGES = [
  { v: "1M", months: 1 },
  { v: "6M", months: 6 },
  { v: "1A", months: 12 },
  { v: "5A", months: 60 },
  { v: "Max", months: 0 },
] as const;

const since = (months: number) => {
  if (!months) return undefined;
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
};

export default function Bourse() {
  const [market, { refetch }] = createResource(store.version, () => api.market());
  return (
    <div class="flex flex-col gap-5">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Bourse</h1>
        <p class="text-muted text-sm">Compte-titres et valeurs suivies · clôtures quotidiennes</p>
      </div>
      <PortfolioCard />
      <Show when={market.latest} fallback={<div class="flex justify-center py-12"><Spinner class="loading-md" /></div>}>
        <div class="grid gap-5 xl:grid-cols-2">
          <For each={market.latest!.items}>{(w) => <WatchCard w={w} hasKey={w.provider === "fred" ? market.latest!.fred_key : market.latest!.alphavantage_key} onChange={refetch} />}</For>
        </div>
      </Show>
      <AddWatch onAdded={refetch} />
    </div>
  );
}

function PortfolioCard() {
  const [p, { refetch }] = createResource(store.version, () => api.portfolio());
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [settings, setSettings] = createSignal(false);
  const save = async (e: Event) => {
    e.preventDefault();
    const cents = parseEuros(value());
    if (cents == null) return;
    setBusy(true);
    try {
      await api.addValuation(cents);
      setValue("");
      store.toast("Valeur du compte-titres enregistrée", "success");
      refetch();
    } catch (err) {
      store.toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  // Série mensuelle continue (mois sans mouvement = cumul inchangé), jusqu'au mois courant.
  const series = createMemo(() => {
    const months = p.latest?.monthly ?? [];
    if (!months.length) return [];
    const byMonth = new Map(months.map((m) => [m.month, m.cumulative_net_cents]));
    const out: { day: string; value: number }[] = [];
    const now = new Date().toISOString().slice(0, 7);
    let [y, mo] = months[0].month.split("-").map(Number);
    let cum = 0;
    for (let guard = 0; guard < 600; guard++) {
      const key = `${y}-${String(mo).padStart(2, "0")}`;
      cum = byMonth.get(key) ?? cum;
      out.push({ day: `${key}-01`, value: cum });
      if (key >= now) break;
      mo++;
      if (mo > 12) [y, mo] = [y + 1, 1];
    }
    return out;
  });
  const markers = createMemo(() => (p.latest?.valuations ?? []).map((v) => ({ day: v.day, value: v.value_cents })));

  return (
    <Card
      title={
        <span class="flex items-center gap-2">
          <Ico icon="lucide:briefcase" /> Compte-titres Revolut
        </span>
      }
      subtitle="Non transmis par l'API bancaire : versements déduits de tes virements, valeur saisie à la main"
      actions={<IconButton icon="lucide:settings-2" label="Réglages" onClick={() => setSettings((s) => !s)} />}
    >
      <Show when={p.latest} fallback={<div class="flex justify-center py-8"><Spinner /></div>}>
        {(pf) => (
          <div class="flex flex-col gap-4">
            <div class="grid gap-3 sm:grid-cols-3">
              <div>
                <div class="text-ink-2 text-sm">Net investi</div>
                <div class="text-3xl font-semibold">{money0(pf().net_invested_cents)}</div>
                <div class="text-muted text-xs">
                  {money0(pf().deposits_cents)} versés · {money0(pf().withdrawals_cents)} retirés
                </div>
              </div>
              <div>
                <div class="text-ink-2 text-sm">Valeur</div>
                <div class="text-3xl font-semibold">{pf().latest ? money0(pf().latest!.value_cents) : "—"}</div>
                <div class="text-muted text-xs">{pf().latest ? `saisie le ${dayLabel(pf().latest!.day)}` : "pas encore saisie"}</div>
              </div>
              <div>
                <div class="text-ink-2 text-sm">Plus-value</div>
                <Show when={pf().gain_cents != null} fallback={<div class="text-3xl font-semibold">—</div>}>
                  <div class={`flex items-center gap-2 text-3xl font-semibold ${pf().gain_cents! >= 0 ? "text-gain" : "text-error"}`}>
                    <Ico icon={pf().gain_cents! >= 0 ? "lucide:trending-up" : "lucide:trending-down"} class="text-2xl" />
                    {(pf().gain_cents! >= 0 ? "+" : "−") + money0(Math.abs(pf().gain_cents!))}
                  </div>
                  <div class="text-muted text-xs">
                    {pf().net_invested_cents > 0 ? `${percent(pf().gain_cents! / pf().net_invested_cents)} du net investi` : ""}
                  </div>
                </Show>
              </div>
            </div>

            <form class="flex flex-wrap items-center gap-2" onSubmit={save}>
              <label class="input input-sm w-56">
                <span class="text-muted text-xs">Valeur actuelle</span>
                <input inputmode="decimal" placeholder="ex. 3 250,40" value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
                <span class="text-muted text-xs">€</span>
              </label>
              <button class="btn btn-sm btn-primary" disabled={busy() || parseEuros(value()) == null}>
                Enregistrer
              </button>
              <span class="text-muted text-xs">Le montant affiché dans Revolut → Investir ; une saisie par jour.</span>
            </form>

            <Show when={series().length > 1}>
              <PriceChart
                data={series()}
                format={(v) => money0(v)}
                label="Net investi (cumulé)"
                markers={markers()}
                markerLabel="Valeur saisie"
                height={200}
                tickLabel={(d) => monthShortYear(d.slice(0, 7))}
              />
            </Show>

            <Show when={settings()}>
              <div class="bg-base-200 rounded-box flex flex-col gap-2 p-3 text-sm">
                <label class="input input-sm w-full">
                  <span class="text-muted text-xs">Libellés des virements</span>
                  <input
                    value={pf().patterns}
                    onChange={async (e) => {
                      try {
                        await api.portfolioPatterns(e.currentTarget.value);
                        refetch();
                      } catch (err) {
                        store.toast(errorText(err), "error");
                      }
                    }}
                  />
                </label>
                <p class="text-muted text-xs">Motifs séparés par « | » : un débit = versement, un crédit = retrait.</p>
                <Show when={pf().valuations.length}>
                  <ul class="flex flex-wrap gap-2">
                    <For each={[...pf().valuations].reverse()}>
                      {(v) => (
                        <li class="badge badge-ghost gap-1">
                          {dayLabel(v.day)} · {money0(v.value_cents)}
                          <button aria-label="Supprimer cette valeur" onClick={async () => (await api.deleteValuation(v.day), refetch())}>
                            <Ico icon="lucide:x" />
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Card>
  );
}

function WatchCard(props: { w: MarketWatch; hasKey: boolean; onChange: () => void }) {
  const w = () => props.w;
  const [range, setRange] = createSignal<number>(12);
  const [refreshing, setRefreshing] = createSignal(false);
  const [confirm, setConfirm] = createSignal(false);
  const [hist] = createResource(
    () => ({ id: w().id, s: since(range()), f: w().fetched_at }),
    ({ id, s }) => api.marketHistory(id, s),
  );
  const isIndex = () => w().provider === "fred";
  const fmt = (v: number) =>
    isIndex()
      ? v.toLocaleString("fr-FR", { maximumFractionDigits: v >= 1000 ? 0 : 2 })
      : new Intl.NumberFormat("fr-FR", { style: "currency", currency: w().currency || "EUR" }).format(v);
  const dayChange = () => (w().last && w().previous ? w().last!.close / w().previous!.close - 1 : null);
  const rangeChange = () => {
    const h = hist.latest ?? [];
    return h.length > 1 ? h[h.length - 1].close / h[0].close - 1 : null;
  };
  const missingKey = () => !props.hasKey;
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.marketRefresh(w().id);
      props.onChange();
    } catch (e) {
      store.toast(errorText(e), "error");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card
      title={w().name}
      subtitle={`${w().symbol} · ${isIndex() ? "indice, FRED (veille)" : "Alpha Vantage"}${w().last ? ` · clôture du ${dayLabel(w().last!.day)}` : ""}`}
      actions={
        <>
          <IconButton icon="lucide:refresh-cw" label="Rafraîchir" class={refreshing() ? "animate-spin" : ""} disabled={refreshing() || missingKey()} onClick={refresh} />
          <Show when={confirm()} fallback={<IconButton icon="lucide:trash-2" label="Ne plus suivre" class="text-muted" onClick={() => setConfirm(true)} />}>
            <button class="btn btn-error btn-xs" onBlur={() => setConfirm(false)} onClick={async () => (await api.marketRemove(w().id), props.onChange())}>
              Retirer
            </button>
          </Show>
        </>
      }
    >
      <Show
        when={!missingKey() || w().last}
        fallback={
          <div class="bg-base-200 rounded-box p-4 text-sm">
            <p class="mb-1 font-medium">Clé {isIndex() ? "FRED" : "Alpha Vantage"} requise (gratuite)</p>
            <p class="text-ink-2">
              À créer sur{" "}
              <span class="font-medium">{isIndex() ? "fredaccount.stlouisfed.org/apikeys" : "alphavantage.co/support/#api-key"}</span>, puis dans{" "}
              <code>config.toml</code> : <code>[market] {isIndex() ? "fred_key" : "alphavantage_key"} = "…"</code> et redémarre le serveur.
            </p>
          </div>
        }
      >
        <Show when={missingKey()}>
          <p class="text-ink-2 mb-3 flex items-start gap-1.5 text-xs">
            <Ico icon="lucide:info" class="mt-0.5" /> Données en cache : ajoute la clé {isIndex() ? "fred_key" : "alphavantage_key"} pour les mises à jour.
          </p>
        </Show>
        <Show when={w().last} fallback={<Empty icon="lucide:chart-line" title={w().last_error ? "Cotation indisponible" : "Pas encore de données"}>{w().last_error ?? "Premier chargement en cours…"}</Empty>}>
          <div class="mb-3 flex flex-wrap items-end gap-x-5 gap-y-1">
            <span class="text-3xl font-semibold">{fmt(w().last!.close)}</span>
            <Change label="sur la séance" value={dayChange()} />
            <Change label={`sur ${RANGES.find((r) => r.months === range())?.v ?? ""}`} value={rangeChange()} />
          </div>
          <div class="tabs tabs-box tabs-xs mb-2 w-fit" role="radiogroup" aria-label="Période">
            <For each={RANGES}>
              {(r) => (
                <button role="radio" aria-checked={range() === r.months} class={`tab ${range() === r.months ? "tab-active" : ""}`} onClick={() => setRange(r.months)}>
                  {r.v}
                </button>
              )}
            </For>
          </div>
          <div class={hist.loading ? "refetching" : ""}>
            <Show when={(hist.latest?.length ?? 0) > 1} fallback={<p class="text-muted py-8 text-center text-sm">Historique insuffisant sur cette période.</p>}>
              <PriceChart
                data={hist.latest!.map((p) => ({ day: p.day, value: p.close }))}
                format={fmt}
                label={w().name}
                tickLabel={range() === 0 || range() > 6 ? (d) => monthShortYear(d.slice(0, 7)) : undefined}
              />
            </Show>
          </div>
          <Show when={w().last_error}>
            <p class="text-error mt-2 flex items-start gap-1 text-xs">
              <Ico icon="lucide:circle-alert" class="mt-0.5" /> Dernier rafraîchissement : {w().last_error}
            </p>
          </Show>
          <Show when={w().fetched_at}>
            <p class="text-muted mt-1 text-xs">mis à jour {relative(w().fetched_at!)}</p>
          </Show>
        </Show>
      </Show>
    </Card>
  );
}

function Change(props: { label: string; value: number | null }) {
  return (
    <Show when={props.value != null}>
      <span class={`inline-flex items-center gap-1 text-sm font-medium ${props.value! >= 0 ? "text-gain" : "text-error"}`}>
        <Ico icon={props.value! >= 0 ? "lucide:trending-up" : "lucide:trending-down"} />
        {(props.value! >= 0 ? "+" : "−") +
          Math.abs(props.value! * 100).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) +
          " %"}
        <span class="text-muted font-normal">{props.label}</span>
      </span>
    </Show>
  );
}

function AddWatch(props: { onAdded: () => void }) {
  const [provider, setProvider] = createSignal("alphavantage");
  const [symbol, setSymbol] = createSignal("");
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const add = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.marketAdd({ provider: provider(), symbol: symbol(), name: name() || symbol(), currency: provider() === "fred" ? "USD" : "EUR" });
      setSymbol("");
      setName("");
      store.toast("Valeur ajoutée", "success");
      props.onAdded();
    } catch (err) {
      store.toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Suivre une autre valeur" subtitle="Action : symbole Alpha Vantage (ex. MC.PAR, AAPL) · indice : série FRED (ex. NASDAQCOM, DJIA)">
      <form class="flex flex-wrap items-center gap-2" onSubmit={add}>
        <select class="select select-sm w-auto" value={provider()} onChange={(e) => setProvider(e.currentTarget.value)} aria-label="Source">
          <option value="alphavantage">Action (Alpha Vantage)</option>
          <option value="fred">Indice (FRED)</option>
        </select>
        <input class="input input-sm w-36" placeholder="Symbole" value={symbol()} onInput={(e) => setSymbol(e.currentTarget.value)} required />
        <input class="input input-sm w-48" placeholder="Nom affiché" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <button class="btn btn-sm" disabled={busy() || !symbol().trim()}>
          <Show when={busy()} fallback={<Ico icon="lucide:plus" />}>
            <Spinner class="loading-xs" />
          </Show>
          Ajouter
        </button>
      </form>
    </Card>
  );
}

