import { useSearchParams } from "@solidjs/router";
import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { api, type Kind, type Tx, type TxFilters } from "../api";
import { CategoryPicker } from "../components/CategoryPicker";
import { Card, Empty, Ico, IconButton, SourceBadge, Spinner } from "../components/ui";
import { dayLabel, dayLong, money, monthLong, prettyMerchant, signedMoney } from "../format";
import { errorText, store } from "../store";

type Params = { month?: string; category?: string; account?: string; q?: string; kind?: string; source?: string };

const KINDS: { v: string; label: string }[] = [
  { v: "", label: "Tout" },
  { v: "expense", label: "Dépenses" },
  { v: "income", label: "Revenus" },
  { v: "transfer", label: "Virements" },
];

export default function Transactions() {
  const [params, setParams] = useSearchParams<Params>();
  const [pages, setPages] = createSignal(1);
  const filters = (): TxFilters => ({
    month: params.month,
    category: params.category,
    account: params.account,
    q: params.q,
    kind: params.kind,
    source: params.source,
    hide_transfers: store.hideTransfers(),
  });
  createEffect(on(() => JSON.stringify(filters()), () => setPages(1), { defer: true }));

  const [data] = createResource(
    () => ({ f: filters(), limit: 100 * pages(), v: store.version() }),
    ({ f, limit }) => api.transactions(f, limit),
  );
  const [accounts] = createResource(() => api.accounts());
  const [summary] = createResource(store.version, () => api.summary());
  const [rule, setRule] = createSignal<{ pattern: string; category: number | null } | null>(null);

  // Recherche : mise à jour de l'URL avec un léger délai.
  let debounce: number | undefined;
  const onSearch = (v: string) => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => setParams({ q: v || undefined }), 250);
  };

  const assign = async (t: Tx, categoryId: number | null) => {
    try {
      const r = await api.setCategory(t.id, categoryId);
      const cat = categoryId != null ? store.categoryById().get(categoryId) : null;
      const similar = r.similar_updated > 0 ? ` · ${r.similar_updated} opération${r.similar_updated > 1 ? "s" : ""} similaire${r.similar_updated > 1 ? "s" : ""} aussi` : "";
      store.toast(
        cat ? `Classé dans « ${cat.name} »${similar}` : "Retour au classement automatique",
        "success",
        cat && t.merchant ? { label: "Créer une règle", run: () => setRule({ pattern: t.merchant!, category: categoryId }) } : undefined,
      );
      store.bump();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };

  const active = () => Object.values(filters()).some((v) => v);
  const sourceTitle = () =>
    params.source === "review" ? "Classements de l'IA à vérifier" : params.category === "none" ? "Opérations sans catégorie" : null;

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">{sourceTitle() ?? "Opérations"}</h1>
          <p class="text-muted text-sm">
            <Show when={data.latest} fallback="Chargement…">
              {data.latest!.total} opération{data.latest!.total > 1 ? "s" : ""}
              <Show when={data.latest!.expenses_cents > 0}> · {money(data.latest!.expenses_cents)} dépensés</Show>
              <Show when={data.latest!.income_cents > 0}> · {money(data.latest!.income_cents)} reçus</Show>
            </Show>
          </p>
        </div>
        <Show when={active()}>
          <button class="btn btn-ghost btn-sm" onClick={() => setParams({ month: undefined, category: undefined, account: undefined, q: undefined, kind: undefined, source: undefined })}>
            <Ico icon="lucide:x" /> Effacer les filtres
          </button>
        </Show>
      </div>

      {/* Filtres : une seule rangée au-dessus de la liste */}
      <div class="flex flex-wrap items-center gap-2">
        <label class="input input-sm w-full sm:w-64">
          <Ico icon="lucide:search" class="text-muted" />
          <input type="search" placeholder="Libellé, marchand…" value={params.q ?? ""} onInput={(e) => onSearch(e.currentTarget.value)} />
        </label>
        <select class="select select-sm w-auto" value={params.month ?? ""} onChange={(e) => setParams({ month: e.currentTarget.value || undefined })} aria-label="Mois">
          <option value="">Tous les mois</option>
          <For each={[...(summary.latest?.months ?? [])].reverse()}>{(m) => <option value={m}>{monthLong(m)}</option>}</For>
        </select>
        <select class="select select-sm w-auto" value={params.category ?? ""} onChange={(e) => setParams({ category: e.currentTarget.value || undefined })} aria-label="Catégorie">
          <option value="">Toutes catégories</option>
          <option value="none">Non classé</option>
          <For each={store.categories()}>{(c) => <option value={String(c.id)}>{c.name}</option>}</For>
        </select>
        <Show when={(accounts.latest?.length ?? 0) > 1}>
          <select class="select select-sm w-auto" value={params.account ?? ""} onChange={(e) => setParams({ account: e.currentTarget.value || undefined })} aria-label="Compte">
            <option value="">Tous les comptes</option>
            <For each={accounts.latest}>{(a) => <option value={a.id}>{a.bank}{a.product ? ` · ${a.product}` : ""}</option>}</For>
          </select>
        </Show>
        <div class="tabs tabs-box tabs-sm" role="radiogroup" aria-label="Type">
          <For each={KINDS}>
            {(k) => (
              <button
                role="radio"
                aria-checked={(params.kind ?? "") === k.v}
                class={`tab ${(params.kind ?? "") === k.v ? "tab-active" : ""}`}
                onClick={() => setParams({ kind: k.v || undefined })}
              >
                {k.label}
              </button>
            )}
          </For>
        </div>
        <label
          class="label cursor-pointer gap-2 text-sm"
          title="Virements entre tes propres comptes et mouvements d'épargne : déjà exclus des totaux, ils encombrent la liste"
        >
          <input
            type="checkbox"
            class="toggle toggle-sm"
            checked={store.hideTransfers() || params.kind === "transfer"}
            disabled={params.kind === "transfer"}
            onChange={(e) => store.setHideTransfers(e.currentTarget.checked)}
          />
          Masquer les virements internes
        </label>
        <button
          class={`btn btn-sm ${params.source === "review" ? "btn-warning" : ""}`}
          onClick={() => setParams({ source: params.source === "review" ? undefined : "review" })}
          aria-pressed={params.source === "review"}
        >
          <Ico icon="lucide:sparkles" /> À vérifier
          <Show when={(store.status()?.counts.to_review ?? 0) > 0}>
            <span class="badge badge-xs">{store.status()!.counts.to_review}</span>
          </Show>
        </button>
      </div>

      <Show when={data.error}>
        <div role="alert" class="alert alert-error">
          <Ico icon="lucide:circle-alert" /> {errorText(data.error)}
        </div>
      </Show>

      <Card class={`!p-0 ${data.loading ? "refetching" : ""}`}>
        <Show when={data.latest} fallback={<div class="flex justify-center py-20"><Spinner class="loading-md" /></div>}>
          <Show when={data.latest!.items.length} fallback={<Empty icon="lucide:search" title="Aucune opération ne correspond" />}>
            <ul class="divide-base-200 divide-y">
              <For each={data.latest!.items}>
                {(t, i) => {
                  const newDay = () => i() === 0 || data.latest!.items[i() - 1].day !== t.day;
                  return (
                    <>
                      <Show when={newDay()}>
                        <li class="bg-base-200/50 text-muted sticky top-0 z-[1] px-4 py-1.5 text-xs font-medium first-letter:uppercase sm:px-5 lg:static">
                          {dayLong(t.day)}
                        </li>
                      </Show>
                      <TxRow tx={t} onAssign={(id) => assign(t, id)} onRule={() => setRule({ pattern: t.merchant ?? t.label, category: t.category_id })} />
                    </>
                  );
                }}
              </For>
            </ul>
            <Show when={data.latest!.items.length < data.latest!.total}>
              <div class="border-base-200 flex justify-center border-t p-3">
                <button class="btn btn-sm btn-ghost" onClick={() => setPages((p) => p + 1)} disabled={data.loading}>
                  <Show when={data.loading} fallback={<Ico icon="lucide:chevron-down" />}>
                    <Spinner class="loading-xs" />
                  </Show>
                  Afficher plus ({data.latest!.total - data.latest!.items.length} restantes)
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </Card>

      <RuleDialog value={rule()} onClose={() => setRule(null)} />
    </div>
  );
}

function TxRow(props: { tx: Tx; onAssign: (id: number | null) => void; onRule: () => void }) {
  const t = () => props.tx;
  const prefer = (): Kind[] => (t().amount_cents < 0 ? ["expense", "transfer", "income"] : ["income", "transfer", "expense"]);
  const title = () => (t().merchant ? prettyMerchant(t().merchant!) : t().label);
  return (
    <li class="hover:bg-base-200/40 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_14rem_5.75rem_4rem_7rem] sm:px-5">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="truncate text-sm font-medium" title={t().label}>
            {title()}
          </span>
          <Show when={t().status !== "BOOK"}>
            <span class="badge badge-ghost badge-xs">en attente</span>
          </Show>
        </div>
        <div class="text-muted flex min-w-0 items-center gap-1.5 text-xs">
          <span class="sm:hidden">{dayLabel(t().day)} ·</span>
          <span class="shrink-0">{t().bank}</span>
          <Show when={t().label.toUpperCase() !== (t().merchant ?? "")}>
            <span class="truncate">· {t().label}</span>
          </Show>
        </div>
      </div>
      <div
        class={`num text-right text-sm font-semibold sm:col-start-5 sm:row-start-1 ${t().kind === "income" ? "text-gain" : t().kind === "transfer" ? "text-muted" : ""}`}
      >
        {t().amount_cents > 0 ? signedMoney(t().amount_cents, t().currency) : money(t().amount_cents, t().currency).replace("-", "−")}
      </div>
      {/* Mobile : 2e ligne ; bureau : colonnes alignées (sm:contents) */}
      <div class="col-span-2 flex min-w-0 items-center gap-1.5 sm:contents">
        <div class="min-w-0 flex-1 sm:col-start-2 sm:row-start-1">
          <CategoryPicker value={t().category_id} onChange={props.onAssign} preferKinds={prefer()} allowClear class="w-full" />
        </div>
        <div class="sm:col-start-3 sm:row-start-1">
          <SourceBadge source={t().category_source} confidence={t().category_confidence} />
        </div>
        <div class="flex justify-end sm:col-start-4 sm:row-start-1">
          <Show when={t().category_source === "ai" && t().category_id != null}>
            <IconButton icon="lucide:check" label="Valider cette catégorie" class="btn-xs" onClick={() => props.onAssign(t().category_id)} />
          </Show>
          <IconButton icon="lucide:list-filter-plus" label="Créer une règle pour ce libellé" class="btn-xs text-muted" onClick={props.onRule} />
        </div>
      </div>
    </li>
  );
}

function RuleDialog(props: { value: { pattern: string; category: number | null } | null; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  const [pattern, setPattern] = createSignal("");
  const [category, setCategory] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  createEffect(() => {
    const v = props.value;
    if (v) {
      setPattern(v.pattern);
      setCategory(v.category);
      dialog.showModal();
    } else if (dialog.open) dialog.close();
  });
  const save = async (e: Event) => {
    e.preventDefault();
    if (category() == null) return;
    setBusy(true);
    try {
      const r = await api.createRule(pattern(), category()!);
      store.toast(`Règle créée · ${r.stats.rule} opération${r.stats.rule > 1 ? "s" : ""} concernée${r.stats.rule > 1 ? "s" : ""}`, "success");
      store.bump();
      props.onClose();
    } catch (err) {
      store.toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={dialog} class="modal" onClose={props.onClose}>
      <form class="modal-box" onSubmit={save}>
        <h3 class="text-lg font-semibold">Nouvelle règle</h3>
        <p class="text-muted mt-1 text-sm">Les opérations dont le libellé contient ce texte seront toujours classées ainsi, y compris les futures.</p>
        <fieldset class="fieldset mt-4">
          <legend class="fieldset-legend">Le libellé contient</legend>
          <input class="input w-full" value={pattern()} onInput={(e) => setPattern(e.currentTarget.value)} minLength={2} required />
          <p class="label">Raccourcis-le pour couvrir plus de cas (ex. « LIDL » plutôt que « TOULOUSE LIDL »).</p>
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Catégorie</legend>
          <div class="border-base-300 rounded-field border px-1">
            <CategoryPicker value={category()} onChange={setCategory} placeholder="Choisir…" class="w-full" mount={dialog} />
          </div>
        </fieldset>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" onClick={props.onClose}>
            Annuler
          </button>
          <button class="btn btn-primary" disabled={busy() || category() == null || pattern().trim().length < 2}>
            <Show when={busy()}>
              <Spinner class="loading-xs" />
            </Show>
            Créer la règle
          </button>
        </div>
      </form>
      <form method="dialog" class="modal-backdrop">
        <button>fermer</button>
      </form>
    </dialog>
  );
}
