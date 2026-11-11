import { createEffect, createSignal, For, Index, Show } from "solid-js";
import { api, type Budget } from "../../api";
import { errorText, store } from "../../store";
import { Ico, IconButton, Spinner } from "../ui";

type Mode = "empty" | "detected" | "copy";

/** Créateur de budget : vierge (avec ses périodes), à partir des dépenses détectées, ou copie. */
export function NewBudgetDialog(props: { open: boolean; current: Budget | null; onClose: () => void; onCreated: (id: number) => void }) {
  let dialog!: HTMLDialogElement;
  const [name, setName] = createSignal("");
  const [mode, setMode] = createSignal<Mode>("empty");
  const [periods, setPeriods] = createSignal([{ name: "Mensuel", months: 12 }]);
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (props.open && !dialog.open) {
      setName("");
      setMode("empty");
      setPeriods([{ name: "Mensuel", months: 12 }]);
      dialog.showModal();
    } else if (!props.open && dialog.open) dialog.close();
  });

  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createBudget({
        name: name().trim(),
        mode: mode(),
        source_id: mode() === "copy" ? props.current?.id : undefined,
        periods: mode() === "empty" ? periods().filter((p) => p.name.trim()) : undefined,
      });
      store.toast(`Budget « ${name().trim()} » créé`, "success");
      props.onCreated(r.id);
      props.onClose();
    } catch (err) {
      store.toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const options: { v: Mode; icon: string; title: string; text: string }[] = [
    { v: "empty", icon: "lucide:table-2", title: "Vierge", text: "Tu définis tes périodes et tes postes, comme dans un tableur." },
    { v: "detected", icon: "lucide:wand-sparkles", title: "Depuis mes dépenses", text: "Abonnements et revenus réguliers détectés, plus la moyenne des 3 derniers mois par catégorie." },
    { v: "copy", icon: "lucide:copy", title: "Copie du budget actuel", text: "Pour préparer une autre année ou un autre scénario." },
  ];

  return (
    <dialog ref={dialog} class="modal" onClose={props.onClose}>
      <form class="modal-box max-w-lg" onSubmit={create}>
        <h3 class="text-lg font-semibold">Nouveau budget</h3>
        <fieldset class="fieldset mt-3">
          <legend class="fieldset-legend">Nom</legend>
          <input class="input w-full" value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="ex. Budget 2027" required maxLength={80} />
        </fieldset>
        <div class="mt-2 grid gap-2">
          <For each={options.filter((o) => o.v !== "copy" || props.current)}>
            {(o) => (
              <label class={`card-surface flex cursor-pointer items-start gap-3 p-3 ${mode() === o.v ? "!border-[var(--series-1)]" : ""}`}>
                <input type="radio" name="mode" class="radio radio-sm mt-1" checked={mode() === o.v} onChange={() => setMode(o.v)} />
                <Ico icon={o.icon} class="text-ink-2 mt-0.5 text-lg" />
                <span>
                  <span class="block text-sm font-medium">{o.title}</span>
                  <span class="text-muted block text-xs">{o.text}</span>
                </span>
              </label>
            )}
          </For>
        </div>
        <Show when={mode() === "empty"}>
          <fieldset class="fieldset mt-2">
            <legend class="fieldset-legend">Périodes (colonnes)</legend>
            <Index each={periods()}>
              {(p, i) => (
                <div class="flex items-center gap-2">
                  <input
                    class="input input-sm flex-1"
                    value={p().name}
                    aria-label="Nom de la période"
                    onInput={(e) => setPeriods((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)))}
                  />
                  <label class="input input-sm w-28">
                    <input
                      type="number"
                      min="1"
                      max="24"
                      value={p().months}
                      aria-label="Durée en mois"
                      onInput={(e) => setPeriods((ps) => ps.map((x, j) => (j === i ? { ...x, months: Number(e.currentTarget.value) || 1 } : x)))}
                    />
                    <span class="text-muted text-xs">mois</span>
                  </label>
                  <IconButton icon="lucide:x" label="Retirer la période" disabled={periods().length <= 1} onClick={() => setPeriods((ps) => ps.filter((_, j) => j !== i))} />
                </div>
              )}
            </Index>
            <button type="button" class="btn btn-ghost btn-sm w-fit" onClick={() => setPeriods((ps) => [...ps, { name: "", months: 1 }])}>
              <Ico icon="lucide:plus" /> Période
            </button>
            <p class="label whitespace-normal">Ex. « Toulouse » × 5 mois puis « Lille » × 4 mois.</p>
          </fieldset>
        </Show>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" onClick={props.onClose}>
            Annuler
          </button>
          <button class="btn btn-primary" disabled={busy() || !name().trim()}>
            <Show when={busy()}>
              <Spinner class="loading-xs" />
            </Show>
            Créer
          </button>
        </div>
      </form>
      <form method="dialog" class="modal-backdrop">
        <button>fermer</button>
      </form>
    </dialog>
  );
}
