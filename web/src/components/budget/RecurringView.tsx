import { createMemo, createSignal, For, Show } from "solid-js";
import { api, type RecurringItem, type RecurringResponse } from "../../api";
import { parseEuros } from "../../budget";
import { dayLabel, money, money0 } from "../../format";
import { errorText, store } from "../../store";
import { CategoryPicker } from "../CategoryPicker";
import { Card, CategoryIcon, Empty, Ico, IconButton } from "../ui";
import { cadenceLabel } from "./TrackingView";

/**
 * Paiements récurrents détectés : abonnements (montant fixe), dépenses régulières (montant variable),
 * revenus réguliers ; chacun indique s'il est couvert par un poste du budget.
 */
export function RecurringView(props: { data: RecurringResponse; uncovered: Set<string>; onAdd: (r: RecurringItem) => void }) {
  const [showStopped, setShowStopped] = createSignal(false);
  const live = (r: RecurringItem) => r.status !== "stopped";
  const groups = createMemo(() => [
    {
      key: "subs",
      title: "Abonnements & prélèvements",
      subtitle: "Montant stable chaque période",
      icon: "lucide:repeat",
      items: props.data.items.filter((r) => live(r) && r.kind === "expense" && r.fixed),
      total: props.data.subscriptions_monthly_cents,
    },
    {
      key: "recurring",
      title: "Dépenses régulières",
      subtitle: "Même marchand à intervalle régulier, montant variable",
      icon: "lucide:calendar-sync",
      items: props.data.items.filter((r) => live(r) && r.kind === "expense" && !r.fixed),
      total: props.data.recurring_expenses_monthly_cents,
    },
    {
      key: "income",
      title: "Revenus réguliers",
      subtitle: "Salaire, aides, virements reçus régulièrement",
      icon: "lucide:hand-coins",
      items: props.data.items.filter((r) => live(r) && r.kind === "income"),
      total: props.data.recurring_income_monthly_cents,
    },
  ]);
  const stopped = () => props.data.items.filter((r) => !live(r));

  return (
    <div class="flex flex-col gap-5">
      <AddManual />
      <div class="grid gap-3 sm:grid-cols-3">
        <For each={groups()}>
          {(g) => (
            <div class="card-surface flex items-center gap-3 p-5">
              <span class="bg-base-200 inline-flex size-10 items-center justify-center rounded-xl text-lg">
                <Ico icon={g.icon} />
              </span>
              <div>
                <div class="text-ink-2 text-sm">{g.title}</div>
                <div class="text-2xl font-semibold">
                  {money0(g.total)}
                  <span class="text-muted text-sm font-normal"> / mois</span>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>

      <For each={groups()}>
        {(g) => (
          <Card title={g.title} subtitle={g.subtitle} actions={<span class="text-muted text-sm">{g.items.length}</span>}>
            <Show when={g.items.length} fallback={<Empty icon={g.icon} title="Rien de détecté" />}>
              <RecurringList items={g.items} uncovered={props.uncovered} onAdd={props.onAdd} />
            </Show>
          </Card>
        )}
      </For>

      <Show when={stopped().length}>
        <Card
          title="Arrêtés"
          subtitle="Réguliers par le passé, plus vus depuis au moins deux échéances"
          actions={
            <button class="btn btn-ghost btn-xs" onClick={() => setShowStopped((v) => !v)}>
              {showStopped() ? "Masquer" : `Afficher (${stopped().length})`}
            </button>
          }
        >
          <Show when={showStopped()}>
            <RecurringList items={stopped()} uncovered={new Set()} onAdd={props.onAdd} />
          </Show>
        </Card>
      </Show>
    </div>
  );
}

function RecurringList(props: { items: RecurringItem[]; uncovered: Set<string>; onAdd: (r: RecurringItem) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ul class="divide-base-200 divide-y">
      <For each={props.items}>
        {(r) => (
          <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <CategoryIcon category={r.category_id != null ? store.categoryById().get(r.category_id) : null} size="sm" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium" title={r.label}>
                  {r.name}
                </span>
                <span class="badge badge-ghost badge-xs">{cadenceLabel(r.cadence)}</span>
                <Show when={r.manual_id != null}>
                  <span class="badge badge-soft badge-primary badge-xs" title={`Défini à la main · motif « ${r.merchant} »`}>
                    manuel
                  </span>
                </Show>
              </div>
              <div class="text-muted text-xs">
                <Show when={r.occurrences > 0} fallback="aucun paiement trouvé pour l'instant">
                  {r.occurrences} fois depuis le {dayLabel(r.first_day)}
                </Show>
                <Show when={r.status === "late" && r.next_day}>
                  <span class="text-ink-2">
                    {" "}
                    · <Ico icon="lucide:clock" /> attendu le {dayLabel(r.next_day!)} — résilié ?
                  </span>
                </Show>
                <Show when={r.status === "active" && r.next_day && r.next_day >= today}> · prochain vers le {dayLabel(r.next_day!)}</Show>
                <Show when={r.status === "stopped"}> · dernier le {dayLabel(r.last_day)}</Show>
              </div>
            </div>
            <div class="text-right">
              <div class={`num text-sm font-semibold ${r.kind === "income" ? "text-gain" : ""}`}>{money(r.amount_cents)}</div>
              <Show when={r.cadence !== "monthly"}>
                <div class="text-muted num text-[11px]">
                  ≈ {money0(r.monthly_cents)}/mois
                  <Show when={r.cadence === "yearly" || r.cadence === "quarterly"}> · {money0(r.total_12m_cents)} sur 12 mois</Show>
                </div>
              </Show>
            </div>
            <Show when={r.manual_id != null}>
              <IconButton
                icon="lucide:trash-2"
                label="Supprimer ce récurrent manuel"
                class="btn-xs text-muted"
                onClick={async () => {
                  try {
                    await api.deleteManualRecurring(r.manual_id!);
                    store.bump();
                  } catch (e) {
                    store.toast(errorText(e), "error");
                  }
                }}
              />
            </Show>
            <div class="w-24 text-right">
              <Show
                when={r.status !== "stopped" && props.uncovered.has(`${r.merchant}|${r.kind}`)}
                fallback={
                  <Show when={r.status !== "stopped"}>
                    <span class="text-gain inline-flex items-center gap-1 text-xs" title="Un poste du budget actif couvre ce paiement">
                      <Ico icon="lucide:circle-check" /> budgété
                    </span>
                  </Show>
                }
              >
                <button class="btn btn-ghost btn-xs" onClick={() => props.onAdd(r)}>
                  <Ico icon="lucide:plus" /> Budget
                </button>
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

/** Récurrent défini à la main : annuels à montant variable, noms de domaine… */
function AddManual() {
  const [open, setOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [pattern, setPattern] = createSignal("");
  const [cadence, setCadence] = createSignal("yearly");
  const [kind, setKind] = createSignal("expense");
  const [category, setCategory] = createSignal<number | null>(null);
  const [expected, setExpected] = createSignal("");
  const add = async (e: Event) => {
    e.preventDefault();
    try {
      await api.addManualRecurring({
        name: name().trim(),
        pattern: pattern().trim(),
        cadence: cadence(),
        kind: kind(),
        category_id: category(),
        expected_cents: parseEuros(expected()) ?? null,
      });
      store.toast(`« ${name().trim()} » ajouté aux récurrents`, "success");
      setName("");
      setPattern("");
      setExpected("");
      setCategory(null);
      setOpen(false);
      store.bump();
    } catch (err) {
      store.toast(errorText(err), "error");
    }
  };
  return (
    <Show
      when={open()}
      fallback={
        <button class="btn btn-sm w-fit" onClick={() => setOpen(true)}>
          <Ico icon="lucide:plus" /> Ajouter un récurrent (annuel, nom de domaine…)
        </button>
      }
    >
      <Card title="Nouveau récurrent" subtitle="Pour ce que la détection ne trouve pas seule : montant qui varie, paiement annuel, plusieurs achats par an">
        <form class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={add}>
          <label class="input input-sm w-full">
            <span class="text-muted text-xs">Nom</span>
            <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="ex. Noms de domaine Cloudflare" required />
          </label>
          <label class="input input-sm w-full">
            <span class="text-muted text-xs">Le libellé contient</span>
            <input value={pattern()} onInput={(e) => setPattern(e.currentTarget.value)} placeholder="ex. CLOUDFLARE" minLength={2} required />
          </label>
          <div class="flex gap-2">
            <select class="select select-sm" value={cadence()} onChange={(e) => setCadence(e.currentTarget.value)} aria-label="Cadence">
              <option value="yearly">Annuel</option>
              <option value="quarterly">Trimestriel</option>
              <option value="monthly">Mensuel</option>
              <option value="weekly">Hebdomadaire</option>
            </select>
            <select class="select select-sm" value={kind()} onChange={(e) => setKind(e.currentTarget.value)} aria-label="Type">
              <option value="expense">Dépense</option>
              <option value="income">Revenu</option>
            </select>
          </div>
          <div class="border-base-300 rounded-field border px-1">
            <CategoryPicker value={category()} onChange={setCategory} placeholder="Catégorie (facultatif)" allowClear class="w-full" />
          </div>
          <label class="input input-sm w-full">
            <span class="text-muted text-xs">Montant attendu</span>
            <input inputmode="decimal" value={expected()} onInput={(e) => setExpected(e.currentTarget.value)} placeholder="facultatif" />
            <span class="text-muted text-xs">€</span>
          </label>
          <div class="flex gap-2">
            <button class="btn btn-sm btn-primary" disabled={!name().trim() || pattern().trim().length < 2}>
              Ajouter
            </button>
            <button type="button" class="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
              Annuler
            </button>
          </div>
        </form>
      </Card>
    </Show>
  );
}
