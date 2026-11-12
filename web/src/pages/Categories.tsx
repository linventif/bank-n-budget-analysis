import { createResource, createSignal, For, Show } from "solid-js";
import { api, type Category, type Kind, type RuleSuggestion } from "../api";
import { CategoryPicker } from "../components/CategoryPicker";
import { IconPicker } from "../components/IconPicker";
import { Card, CategoryIcon, Empty, Ico, IconButton, KindLabel, Spinner } from "../components/ui";
import { dayLabel } from "../format";
import { errorText, store } from "../store";

const KINDS: Kind[] = ["expense", "income", "transfer"];

export default function Categories() {
  const [tab, setTab] = createSignal<Kind>("expense");
  const list = () => store.categories().filter((c) => c.kind === tab());

  const save = async (c: Category, patch: Partial<Category>) => {
    try {
      await api.updateCategory(c.id, patch);
      store.bump();
    } catch (e) {
      store.toast(errorText(e), "error");
      store.bump();
    }
  };

  return (
    <div class="flex flex-col gap-5">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Catégories</h1>
        <p class="text-muted text-sm">Organise-les comme tu veux. Les descriptions aident l'IA à choisir.</p>
      </div>

      <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card class="!p-0">
          <div class="border-base-200 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
            <div role="tablist" class="tabs tabs-box tabs-sm">
              <For each={KINDS}>
                {(k) => (
                  <button role="tab" aria-selected={tab() === k} class={`tab ${tab() === k ? "tab-active" : ""}`} onClick={() => setTab(k)}>
                    <KindLabel kind={k} />
                    <span class="text-muted ml-1.5 text-xs">{store.categories().filter((c) => c.kind === k).length}</span>
                  </button>
                )}
              </For>
            </div>
            <NewCategory kind={tab()} />
          </div>
          <ul class="divide-base-200 divide-y">
            <For each={list()}>{(c) => <CategoryRow c={c} onSave={(p) => save(c, p)} />}</For>
          </ul>
          <Show when={list().length === 0}>
            <Empty icon="lucide:tags" title="Aucune catégorie de ce type" />
          </Show>
        </Card>

        <Rules />
      </div>
    </div>
  );
}

function CategoryRow(props: { c: Category; onSave: (p: Partial<Category>) => void }) {
  const c = () => props.c;
  const [confirm, setConfirm] = createSignal(false);
  const remove = async () => {
    try {
      await api.deleteCategory(c().id);
      store.toast(`« ${c().name} » supprimée`, "success");
      store.bump();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };

  return (
    <li class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
      <IconPicker value={c().icon} onChange={(icon) => props.onSave({ icon })} />
      <div class="flex min-w-0 flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <input
            class="input input-sm input-ghost -ml-3 max-w-xs font-medium"
            value={c().name}
            aria-label="Nom"
            onChange={(e) => {
              const v = e.currentTarget.value.trim();
              if (v && v !== c().name) props.onSave({ name: v });
            }}
          />
          <span class="text-muted text-xs">
            {c().tx_count} opération{c().tx_count > 1 ? "s" : ""}
          </span>
          <Show when={c().role}>
            <span class="badge badge-ghost badge-xs" title="Utilisée par la détection automatique des virements">
              auto
            </span>
          </Show>
        </div>
        <input
          class="input input-sm input-ghost text-ink-2 -ml-3 w-full text-xs"
          value={c().description}
          placeholder="Description pour l'IA (enseignes, exemples…)"
          aria-label="Description"
          onChange={(e) => {
            const v = e.currentTarget.value.trim();
            if (v !== c().description) props.onSave({ description: v });
          }}
        />
      </div>
      <div class="flex items-center gap-1">
        <Show
          when={confirm()}
          fallback={<IconButton icon="lucide:trash-2" label={`Supprimer ${c().name}`} class="text-muted" onClick={() => setConfirm(true)} />}
        >
          <button class="btn btn-error btn-xs" onClick={remove}>
            Supprimer
          </button>
          <IconButton icon="lucide:x" label="Annuler" class="btn-xs" onClick={() => setConfirm(false)} />
        </Show>
      </div>
    </li>
  );
}

function NewCategory(props: { kind: Kind }) {
  let dialog!: HTMLDialogElement;
  const [name, setName] = createSignal("");
  const [icon, setIcon] = createSignal("lucide:tag");
  const [description, setDescription] = createSignal("");
  const create = async (e: Event) => {
    e.preventDefault();
    try {
      await api.createCategory({ name: name().trim(), icon: icon(), kind: props.kind, description: description().trim() });
      store.toast(`Catégorie « ${name().trim()} » créée`, "success");
      store.bump();
      dialog.close();
    } catch (err) {
      store.toast(errorText(err), "error");
    }
  };
  return (
    <>
      <button
        class="btn btn-sm btn-primary"
        onClick={() => {
          setName("");
          setIcon("lucide:tag");
          setDescription("");
          dialog.showModal();
        }}
      >
        <Ico icon="lucide:plus" /> Nouvelle
      </button>
      <dialog ref={dialog} class="modal">
        <form class="modal-box" onSubmit={create}>
          <h3 class="text-lg font-semibold">
            Nouvelle catégorie · <KindLabel kind={props.kind} />
          </h3>
          <div class="mt-4 flex items-end gap-3">
            <IconPicker value={icon()} onChange={setIcon} />
            <fieldset class="fieldset flex-1 py-0">
              <legend class="fieldset-legend">Nom</legend>
              <input class="input w-full" value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxLength={60} />
            </fieldset>
          </div>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Description pour l'IA</legend>
            <textarea
              class="textarea w-full"
              rows="2"
              placeholder="ex. abonnement moto, essence moto, équipement (Dafy, Motoblouz)"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </fieldset>
          <div class="modal-action">
            <button type="button" class="btn btn-ghost" onClick={() => dialog.close()}>
              Annuler
            </button>
            <button class="btn btn-primary" disabled={!name().trim()}>
              Créer
            </button>
          </div>
        </form>
        <form method="dialog" class="modal-backdrop">
          <button>fermer</button>
        </form>
      </dialog>
    </>
  );
}

function Rules() {
  const [rules] = createResource(store.version, () => api.rules());
  const [pattern, setPattern] = createSignal("");
  const [category, setCategory] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);

  const add = async (e: Event) => {
    e.preventDefault();
    if (category() == null) return;
    setBusy(true);
    try {
      const r = await api.createRule(pattern().trim(), category()!);
      store.toast(`Règle ajoutée · ${r.stats.rule} opération${r.stats.rule > 1 ? "s" : ""} classée${r.stats.rule > 1 ? "s" : ""} par règle`, "success");
      setPattern("");
      store.bump();
    } catch (err) {
      store.toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number) => {
    try {
      await api.deleteRule(id);
      store.bump();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };

  return (
    <Card
      title="Règles"
      subtitle="Prioritaires sur l'IA, appliquées aussi aux futures opérations"
      class="self-start"
      actions={<RuleSuggestions />}
    >
      <form class="flex flex-col gap-2" onSubmit={add}>
        <label class="input input-sm w-full">
          <span class="text-muted text-xs">Contient</span>
          <input value={pattern()} onInput={(e) => setPattern(e.currentTarget.value)} placeholder="ex. LIDL" minLength={2} required />
        </label>
        <div class="flex items-center gap-2">
          <div class="border-base-300 rounded-field min-w-0 flex-1 border px-1">
            <CategoryPicker value={category()} onChange={setCategory} placeholder="Catégorie…" class="w-full" />
          </div>
          <button class="btn btn-sm btn-primary" disabled={busy() || category() == null || pattern().trim().length < 2}>
            <Show when={busy()} fallback={<Ico icon="lucide:plus" />}>
              <Spinner class="loading-xs" />
            </Show>
            Ajouter
          </button>
        </div>
      </form>

      <div class="mt-4">
        <Show when={rules.latest} fallback={<div class="flex justify-center py-6"><Spinner /></div>}>
          <Show when={rules.latest!.length} fallback={<p class="text-muted py-4 text-center text-sm">Aucune règle. Tu peux aussi en créer depuis une opération.</p>}>
            <ul class="divide-base-200 divide-y">
              <For each={rules.latest}>
                {(r) => {
                  const cat = () => store.categoryById().get(r.category_id);
                  return (
                    <li class="flex items-center gap-2.5 py-2">
                      <CategoryIcon category={cat()} size="sm" />
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm">
                          « <span class="font-medium">{r.pattern}</span> » → {cat()?.name}
                        </div>
                        <div class="text-muted text-xs">
                          {r.matches} opération{r.matches > 1 ? "s" : ""} · créée le {dayLabel(r.created_at.slice(0, 10))}
                        </div>
                      </div>
                      <IconButton icon="lucide:trash-2" label="Supprimer la règle" class="btn-xs text-muted" onClick={() => remove(r.id)} />
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </Card>
  );
}

const REASON: Record<RuleSuggestion["reason"], { label: string; icon: string }> = {
  similar: { label: "Libellés similaires", icon: "lucide:copy" },
  recurring: { label: "Récurrent", icon: "lucide:repeat" },
  frequent: { label: "Fréquent", icon: "lucide:activity" },
};

/** Bouton + modale : règles probables (même enseigne sous plusieurs libellés, marchands récurrents). */
function RuleSuggestions() {
  let dialog!: HTMLDialogElement;
  const [open, setOpen] = createSignal(false);
  const [data, { refetch }] = createResource(open, () => api.ruleSuggestions());

  const show = () => {
    setOpen(true);
    refetch();
    dialog.showModal();
  };
  const reset = async () => {
    try {
      await api.resetSuggestions();
      refetch();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };

  return (
    <>
      <button class="btn btn-sm btn-ghost" onClick={show} title="Proposer des règles à partir de tes opérations">
        <Ico icon="lucide:sparkles" /> Suggérer
      </button>
      <dialog ref={dialog} class="modal" onClose={() => setOpen(false)}>
        <div class="modal-box flex max-h-[85vh] max-w-2xl flex-col p-0">
          <div class="border-base-200 border-b px-5 py-4">
            <h3 class="text-lg font-semibold">Règles suggérées</h3>
            <p class="text-muted mt-0.5 text-sm">
              Enseignes vues sous plusieurs libellés et marchands récurrents. Catégorie proposée : celle déjà majoritaire, modifiable.
            </p>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-5">
            <Show when={data.latest} fallback={<div class="flex justify-center py-10"><Spinner /></div>}>
              <Show
                when={data.latest!.items.length}
                fallback={
                  <Empty icon="lucide:check-check" title="Rien à proposer">
                    Tes opérations similaires sont déjà couvertes par des règles.
                  </Empty>
                }
              >
                <ul class="divide-base-200 divide-y">
                  <For each={data.latest!.items}>{(sug) => <SuggestionRow s={sug} mount={dialog} onDone={refetch} />}</For>
                </ul>
              </Show>
            </Show>
          </div>
          <div class="border-base-200 flex items-center justify-between gap-3 border-t px-5 py-3">
            <span class="text-muted text-xs">
              <Show when={data.latest?.dismissed}>
                {(n) => (
                  <>
                    {n()} ignorée{n() > 1 ? "s" : ""} ·{" "}
                    <button class="link" onClick={reset}>
                      réafficher
                    </button>
                  </>
                )}
              </Show>
            </span>
            <button class="btn btn-sm" onClick={() => dialog.close()}>
              Fermer
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button>fermer</button>
        </form>
      </dialog>
    </>
  );
}

function SuggestionRow(props: { s: RuleSuggestion; mount: Node; onDone: () => void }) {
  const s = () => props.s;
  const [category, setCategory] = createSignal<number | null>(props.s.category_id);
  const [busy, setBusy] = createSignal(false);
  const mixed = () => s().categories.length > 1;

  const accept = async () => {
    if (category() == null) return;
    setBusy(true);
    try {
      const r = await api.createRules(s().patterns, category()!);
      const n = r.stats.rule;
      store.toast(`Règle${s().patterns.length > 1 ? "s" : ""} créée${s().patterns.length > 1 ? "s" : ""} · ${n} opération${n > 1 ? "s" : ""} classée${n > 1 ? "s" : ""} par règle`, "success");
      store.bump();
      props.onDone();
    } catch (e) {
      store.toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    try {
      await api.dismissSuggestion(s().key);
      props.onDone();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };

  return (
    <li class="flex flex-col gap-2 py-3.5">
      <div class="flex flex-wrap items-center gap-1.5">
        <For each={s().patterns}>{(p) => <span class="badge badge-neutral badge-sm font-mono">{p}</span>}</For>
        <span class="text-muted inline-flex items-center gap-1 text-xs">
          <Ico icon={REASON[s().reason].icon} /> {REASON[s().reason].label}
        </span>
        <span class="text-muted ml-auto text-xs">
          {s().matches} opération{s().matches > 1 ? "s" : ""} · {s().months} mois
        </span>
      </div>
      <p class="text-ink-2 truncate text-xs" title={s().merchants.join(" · ")}>
        {s().merchants.slice(0, 4).join(" · ")}
        <Show when={s().merchants.length > 4}> · +{s().merchants.length - 4}</Show>
      </p>
      <Show when={mixed()}>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span class="text-warning inline-flex items-center gap-1">
            <Ico icon="lucide:shuffle" /> Classées aujourd'hui en :
          </span>
          <For each={s().categories}>
            {(c) => (
              <span class="text-muted inline-flex items-center gap-1">
                {c.category_id == null ? "Non classé" : (store.categoryById().get(c.category_id)?.name ?? "?")}
                <span class="tabular-nums">×{c.count}</span>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="flex items-center gap-2">
        <div class="border-base-300 rounded-field min-w-0 flex-1 border px-1">
          <CategoryPicker value={category()} onChange={setCategory} placeholder="Catégorie…" class="w-full" mount={props.mount} />
        </div>
        <button class="btn btn-sm btn-primary" disabled={busy() || category() == null} onClick={accept}>
          <Show when={busy()} fallback={<Ico icon="lucide:check" />}>
            <Spinner class="loading-xs" />
          </Show>
          Créer
        </button>
        <IconButton icon="lucide:eye-off" label="Ignorer cette suggestion" class="text-muted" onClick={dismiss} />
      </div>
    </li>
  );
}
