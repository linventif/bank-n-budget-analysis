import { useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api, type Budget, type RecurringItem } from "../api";
import { LineDialog, type LineDraft } from "../components/budget/LineDialog";
import { NewBudgetDialog } from "../components/budget/NewBudgetDialog";
import { PlanEditor } from "../components/budget/PlanEditor";
import { RecurringView } from "../components/budget/RecurringView";
import { TrackingView } from "../components/budget/TrackingView";
import { Card, Empty, Ico, Spinner } from "../components/ui";
import { errorText, store } from "../store";

type Params = { b?: string; tab?: string; month?: string; period?: string };
const TABS = [
  { v: "suivi", label: "Suivi", icon: "lucide:gauge" },
  { v: "plan", label: "Plan", icon: "lucide:table-2" },
  { v: "recurrents", label: "Récurrents", icon: "lucide:repeat" },
] as const;

export default function BudgetPage() {
  const [params, setParams] = useSearchParams<Params>();
  const tab = () => (TABS.some((t) => t.v === params.tab) ? params.tab! : "suivi");

  const [list, { refetch: refetchList }] = createResource(store.version, () => api.budgets());
  const selectedId = () => {
    const all = list.latest ?? [];
    const wanted = Number(params.b);
    return all.find((x) => x.id === wanted)?.id ?? all.find((x) => x.is_active)?.id ?? all[0]?.id ?? null;
  };
  // Budget courant dans un store « réconcilié » : les lignes gardent leur identité entre deux
  // rechargements, donc le tableau ne perd pas le focus pendant la saisie.
  const [state, setState] = createStore<{ b: Budget | null }>({ b: null });
  createEffect(
    on([() => list.latest, selectedId], ([all, id]) => {
      const found = all?.find((x) => x.id === id) ?? null;
      setState("b", reconcile(found, { key: "id" }));
    }),
  );

  const [tracking, { refetch: refetchTracking }] = createResource(
    () => (selectedId() != null ? { id: selectedId()!, month: params.month, period: params.period, v: store.version() } : false),
    ({ id, month, period }) => api.tracking(id, month, period ? Number(period) : undefined),
  );
  const [recurring] = createResource(store.version, () => api.recurring());

  const refresh = () => {
    refetchList();
    refetchTracking();
  };

  const [draft, setDraft] = createSignal<LineDraft | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  const uncovered = createMemo(() => new Set((tracking.latest?.suggestions ?? []).map((r) => `${r.merchant}|${r.kind}`)));
  const addRecurring = (r: RecurringItem) => {
    const p = tracking.latest?.period;
    setDraft({
      section: r.kind === "income" ? "Aides" : r.fixed ? "Abonnements" : "Dépenses régulières",
      name: r.name,
      kind: r.kind === "income" ? "income" : "expense",
      category_id: r.category_id,
      match: r.merchant,
      once_cents: null,
      amounts: p ? { [String(p.id)]: r.monthly_cents } : {},
    });
  };

  const act = async (p: Promise<unknown>, ok: string) => {
    try {
      await p;
      store.toast(ok, "success");
      refresh();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold tracking-tight">Budget</h1>
          <Show when={state.b} fallback={<p class="text-muted text-sm">Prévois tes dépenses et compare-les à la réalité</p>}>
            {(b) => (
              <div class="flex flex-wrap items-center gap-2">
                <input
                  class="input input-ghost input-sm -ml-2 h-7 w-56 px-2 font-medium"
                  value={b().name}
                  aria-label="Nom du budget"
                  onChange={(e) => {
                    const v = e.currentTarget.value.trim();
                    if (v && v !== b().name) act(api.updateBudget(b().id, { name: v }), "Budget renommé");
                  }}
                />
                <Show
                  when={b().is_active}
                  fallback={
                    <button class="btn btn-ghost btn-xs" onClick={() => act(api.updateBudget(b().id, { is_active: true }), `« ${b().name} » est le budget actif`)}>
                      Définir comme actif
                    </button>
                  }
                >
                  <span class="badge badge-success badge-sm badge-soft" title="Utilisé par le tableau de bord">
                    actif
                  </span>
                </Show>
                <span class="text-muted text-xs">{b().periods.map((p) => `${p.name} × ${p.months}`).join(" · ")}</span>
              </div>
            )}
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={(list.latest?.length ?? 0) > 1}>
            <select class="select select-sm w-48" value={String(selectedId() ?? "")} onChange={(e) => setParams({ b: e.currentTarget.value, month: undefined, period: undefined })} aria-label="Budget">
              <For each={list.latest}>{(b) => <option value={String(b.id)}>{b.name}{b.is_active ? " (actif)" : ""}</option>}</For>
            </select>
          </Show>
          <button class="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            <Ico icon="lucide:plus" /> Nouveau budget
          </button>
          <Show when={state.b}>
            <Show
              when={confirmDelete()}
              fallback={
                <button class="btn btn-sm btn-ghost btn-square" title="Supprimer ce budget" aria-label="Supprimer ce budget" onClick={() => setConfirmDelete(true)}>
                  <Ico icon="lucide:trash-2" />
                </button>
              }
            >
              <button
                class="btn btn-sm btn-error"
                onBlur={() => setConfirmDelete(false)}
                onClick={() => {
                  setConfirmDelete(false);
                  act(api.deleteBudget(state.b!.id), "Budget supprimé").then(() => setParams({ b: undefined }));
                }}
              >
                Supprimer « {state.b!.name} »
              </button>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={list.latest} fallback={<div class="flex justify-center py-24"><Spinner class="loading-lg" /></div>}>
        <Show
          when={state.b}
          fallback={
            <Card>
              <Empty icon="lucide:calculator" title="Aucun budget pour l'instant">
                <p>Crée-le comme un tableur (périodes en colonnes, postes en lignes), ou laisse l'app partir de tes dépenses détectées.</p>
                <button class="btn btn-primary btn-sm mt-3" onClick={() => setCreating(true)}>
                  <Ico icon="lucide:plus" /> Créer un budget
                </button>
              </Empty>
            </Card>
          }
        >
          <div role="tablist" class="tabs tabs-box w-fit">
            <For each={TABS}>
              {(t) => (
                <button role="tab" aria-selected={tab() === t.v} class={`tab gap-2 ${tab() === t.v ? "tab-active" : ""}`} onClick={() => setParams({ tab: t.v === "suivi" ? undefined : t.v })}>
                  <Ico icon={t.icon} /> {t.label}
                  <Show when={t.v === "recurrents" && (tracking.latest?.suggestions.length ?? 0) > 0}>
                    <span class="badge badge-xs" title="Récurrents hors budget">
                      {tracking.latest!.suggestions.length}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>

          <Show when={tab() === "suivi"}>
            <Show when={tracking.latest} fallback={<div class="flex justify-center py-16"><Spinner class="loading-md" /></div>}>
              <TrackingView
                budget={state.b!}
                tracking={tracking.latest!}
                loading={tracking.loading}
                onMonth={(m) => setParams({ month: m })}
                onPeriod={(id) => setParams({ period: id == null ? undefined : String(id) })}
                onChange={refresh}
                onEditLine={setDraft}
              />
            </Show>
          </Show>
          <Show when={tab() === "plan"}>
            <PlanEditor budget={state.b!} onChange={refresh} onEditLine={setDraft} />
            <Show when={state.b!.notes}>
              <p class="text-muted text-sm">{state.b!.notes}</p>
            </Show>
          </Show>
          <Show when={tab() === "recurrents"}>
            <Show when={recurring.latest} fallback={<div class="flex justify-center py-16"><Spinner class="loading-md" /></div>}>
              <RecurringView data={recurring.latest!} uncovered={uncovered()} onAdd={addRecurring} />
            </Show>
          </Show>
        </Show>
      </Show>

      <Show when={state.b}>
        <LineDialog budget={state.b!} draft={draft()} onClose={() => setDraft(null)} onSaved={refresh} />
      </Show>
      <NewBudgetDialog
        open={creating()}
        current={state.b}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          refetchList();
          setParams({ b: String(id), tab: "plan", month: undefined, period: undefined });
        }}
      />
    </div>
  );
}
