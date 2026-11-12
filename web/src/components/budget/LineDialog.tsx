import { createEffect, createSignal, For, Show } from "solid-js";
import { api, type Budget, type LineKind } from "../../api";
import { KIND_LABEL } from "../../budget";
import { errorText, store } from "../../store";
import { CategoryPicker } from "../CategoryPicker";
import { EuroInput } from "../EuroInput";
import { Ico, Spinner } from "../ui";

export type LineDraft = {
  id?: number;
  section: string;
  name: string;
  kind: LineKind;
  category_id: number | null;
  match: string | null;
  once_cents: number | null;
  amounts: Record<string, number | null>;
  scope?: "vie" | "alternance";
};

const KINDS: LineKind[] = ["expense", "income", "salary", "info"];

/** Création / modification d'un poste : rattachement aux opérations (motif ou catégorie) et montants. */
export function LineDialog(props: { budget: Budget; draft: LineDraft | null; onClose: () => void; onSaved: () => void }) {
  let dialog!: HTMLDialogElement;
  const [d, setD] = createSignal<LineDraft | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  createEffect(() => {
    const draft = props.draft;
    if (draft) {
      setD({ ...draft, amounts: { ...draft.amounts } });
      setConfirmDelete(false);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  });
  const patch = (p: Partial<LineDraft>) => setD((x) => (x ? { ...x, ...p } : x));
  const sections = () => [...new Set(props.budget.lines.map((l) => l.section).filter(Boolean))];

  const save = async (e: Event) => {
    e.preventDefault();
    const x = d();
    if (!x || !x.name.trim()) return;
    setBusy(true);
    try {
      const body = {
        section: x.section.trim(),
        name: x.name.trim(),
        kind: x.kind,
        category_id: x.category_id,
        match: x.match?.trim() || null,
        once_cents: x.once_cents,
        amounts: x.amounts,
        scope: x.scope ?? "vie",
      };
      if (x.id) await api.updateLine(x.id, body);
      else await api.addLine(props.budget.id, body);
      store.toast(x.id ? "Poste enregistré" : `Poste « ${x.name.trim()} » ajouté`, "success");
      props.onSaved();
      props.onClose();
    } catch (err) {
      store.toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const x = d();
    if (!x?.id) return;
    try {
      await api.deleteLine(x.id);
      store.toast(`Poste « ${x.name} » supprimé`, "success");
      props.onSaved();
      props.onClose();
    } catch (err) {
      store.toast(errorText(err), "error");
    }
  };

  return (
    <dialog ref={dialog} class="modal" onClose={props.onClose}>
      <Show when={d()}>
        {(x) => (
          <form class="modal-box max-w-lg" onSubmit={save}>
            <h3 class="text-lg font-semibold">{x().id ? "Modifier le poste" : "Nouveau poste"}</h3>

            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              <fieldset class="fieldset py-0">
                <legend class="fieldset-legend">Nom</legend>
                <input class="input w-full" value={x().name} onInput={(e) => patch({ name: e.currentTarget.value })} required maxLength={80} />
              </fieldset>
              <fieldset class="fieldset py-0">
                <legend class="fieldset-legend">Section</legend>
                <input class="input w-full" list="budget-sections" value={x().section} onInput={(e) => patch({ section: e.currentTarget.value })} placeholder="ex. Obligatoire" />
                <datalist id="budget-sections">
                  <For each={sections()}>{(s) => <option value={s} />}</For>
                </datalist>
              </fieldset>
            </div>

            <fieldset class="fieldset">
              <legend class="fieldset-legend">Type</legend>
              <div class="tabs tabs-box tabs-sm w-fit" role="radiogroup">
                <For each={KINDS}>
                  {(k) => (
                    <button type="button" role="radio" aria-checked={x().kind === k} class={`tab ${x().kind === k ? "tab-active" : ""}`} onClick={() => patch({ kind: k })}>
                      {KIND_LABEL[k]}
                    </button>
                  )}
                </For>
              </div>
              <p class="label whitespace-normal">
                {x().kind === "income"
                  ? "Réduit le reste à charge (APL, aides…)."
                  : x().kind === "salary"
                    ? "Revenu principal : sert à calculer ce qui reste disponible."
                    : x().kind === "info"
                      ? "Affiché et suivi, mais exclu des totaux (salaire brut, épargne…)."
                      : "Compté dans les dépenses du budget."}
              </p>
            </fieldset>

            <fieldset class="fieldset">
              <legend class="fieldset-legend">Périmètre</legend>
              <div class="tabs tabs-box tabs-sm w-fit" role="radiogroup">
                <For each={[{ v: "vie", l: "Vie courante" }, { v: "alternance", l: "Alternance" }] as const}>
                  {(s) => (
                    <button type="button" role="radio" aria-checked={(x().scope ?? "vie") === s.v} class={`tab ${(x().scope ?? "vie") === s.v ? "tab-active" : ""}`} onClick={() => patch({ scope: s.v })}>
                      {s.l}
                    </button>
                  )}
                </For>
              </div>
              <p class="label whitespace-normal">
                {(x().scope ?? "vie") === "alternance"
                  ? "Temporaire : disparaît après l'alternance (loyer, APL, trajets…)."
                  : "Permanent : reste après l'alternance (abonnements, mobile, sport…)."}
              </p>
            </fieldset>

            <fieldset class="fieldset">
              <legend class="fieldset-legend">Suivi automatique</legend>
              <label class="input w-full">
                <span class="text-muted text-xs">Le libellé contient</span>
                <input value={x().match ?? ""} onInput={(e) => patch({ match: e.currentTarget.value })} placeholder="ex. BASIC FIT" />
              </label>
              <div class="border-base-300 rounded-field mt-1 border px-1">
                <CategoryPicker
                  value={x().category_id}
                  onChange={(id) => patch({ category_id: id })}
                  placeholder="Ou toute une catégorie…"
                  allowClear
                  class="w-full"
                  mount={dialog}
                />
              </div>
              <p class="label whitespace-normal">
                Le motif est prioritaire : un poste à motif « attrape » ses opérations avant les postes par catégorie.
              </p>
            </fieldset>

            <fieldset class="fieldset">
              <legend class="fieldset-legend">Montants mensuels prévus</legend>
              <div class="grid gap-2 sm:grid-cols-2">
                <For each={props.budget.periods}>
                  {(p) => (
                    <label class="input w-full">
                      <span class="text-muted text-xs whitespace-nowrap">
                        {p.name} <span class="opacity-70">× {p.months}</span>
                      </span>
                      <EuroInput
                        label={`Montant ${p.name}`}
                        value={x().amounts[String(p.id)] ?? null}
                        onCommit={(c) => patch({ amounts: { ...x().amounts, [String(p.id)]: c } })}
                        class="!border-0 !bg-transparent"
                      />
                      <span class="text-muted text-xs">€</span>
                    </label>
                  )}
                </For>
                <label class="input w-full">
                  <span class="text-muted text-xs whitespace-nowrap">Annuel / ponctuel</span>
                  <EuroInput label="Montant annuel ou ponctuel" value={x().once_cents} onCommit={(c) => patch({ once_cents: c })} class="!border-0 !bg-transparent" />
                  <span class="text-muted text-xs">€</span>
                </label>
              </div>
            </fieldset>

            <div class="modal-action items-center">
              <Show when={x().id}>
                <Show
                  when={confirmDelete()}
                  fallback={
                    <button type="button" class="btn btn-ghost text-error mr-auto" onClick={() => setConfirmDelete(true)}>
                      <Ico icon="lucide:trash-2" /> Supprimer
                    </button>
                  }
                >
                  <button type="button" class="btn btn-error mr-auto" onClick={remove}>
                    Confirmer la suppression
                  </button>
                </Show>
              </Show>
              <button type="button" class="btn btn-ghost" onClick={props.onClose}>
                Annuler
              </button>
              <button class="btn btn-primary" disabled={busy() || !x().name.trim()}>
                <Show when={busy()}>
                  <Spinner class="loading-xs" />
                </Show>
                Enregistrer
              </button>
            </div>
          </form>
        )}
      </Show>
      <form method="dialog" class="modal-backdrop">
        <button>fermer</button>
      </form>
    </dialog>
  );
}
