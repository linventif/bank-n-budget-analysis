import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { Category, Kind } from "../api";
import { store } from "../store";
import { CategoryIcon, Ico, KindLabel } from "./ui";

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * Bouton + liste déroulante filtrable des catégories.
 * Positionnée en `fixed` dans un portail : jamais coupée par un tableau qui défile.
 */
export function CategoryPicker(props: {
  value: number | null;
  onChange: (id: number | null) => void;
  /** Sens de l'opération : met en avant les catégories cohérentes. */
  preferKinds?: Kind[];
  allowClear?: boolean;
  placeholder?: string;
  compact?: boolean;
  class?: string;
  /** À fournir dans une modale (<dialog>) : la liste doit vivre dans la même couche d'affichage. */
  mount?: Node;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [pos, setPos] = createSignal({ left: 0, top: 0, up: false });
  let trigger!: HTMLButtonElement;
  let input!: HTMLInputElement;

  const current = () => (props.value == null ? null : store.categoryById().get(props.value) ?? null);

  const groups = createMemo(() => {
    const q = norm(query().trim());
    const pref = props.preferKinds ?? ["expense", "income", "transfer"];
    const order: Kind[] = [...pref, ...(["expense", "income", "transfer"] as Kind[]).filter((k) => !pref.includes(k))];
    return order
      .map((kind) => ({
        kind,
        items: store
          .categories()
          .filter((c) => c.kind === kind && (!q || norm(c.name).includes(q) || norm(c.description).includes(q))),
      }))
      .filter((g) => g.items.length > 0);
  });
  const flat = createMemo(() => groups().flatMap((g) => g.items));

  const place = () => {
    const r = trigger.getBoundingClientRect();
    const up = r.bottom + 380 > window.innerHeight && r.top > 380;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 320 - 8));
    setPos({ left, top: up ? r.top - 4 : r.bottom + 4, up });
  };

  const show = () => {
    place();
    setQuery("");
    setActive(Math.max(0, flat().findIndex((c) => c.id === props.value)));
    setOpen(true);
    queueMicrotask(() => input?.focus());
  };
  const close = () => setOpen(false);
  const choose = (c: Category | null) => {
    close();
    if ((c?.id ?? null) !== props.value) props.onChange(c?.id ?? null);
    trigger.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const n = flat().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (n ? (a + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (n ? (a - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = flat()[active()];
      if (c) choose(c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      trigger.focus();
    }
  };

  const outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (open() && !trigger.contains(t) && !document.getElementById("cat-picker-pop")?.contains(t)) close();
  };
  const reposition = () => open() && place();
  document.addEventListener("pointerdown", outside);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  onCleanup(() => {
    document.removeEventListener("pointerdown", outside);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={`btn btn-ghost h-auto min-h-0 justify-start gap-2 px-1.5 py-1 font-normal ${props.class ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? close() : show())}
      >
        <CategoryIcon category={current()} size="sm" />
        <Show when={!props.compact}>
          <span class={`truncate text-sm ${current() ? "" : "text-muted"}`}>
            {current()?.name ?? props.placeholder ?? "Non classé"}
          </span>
        </Show>
        <Ico icon="lucide:chevron-down" class="text-muted ml-auto text-xs" />
      </button>

      <Show when={open()}>
        <Portal mount={props.mount}>
          <div
            id="cat-picker-pop"
            class="card-surface fixed z-50 flex max-h-[372px] w-80 flex-col overflow-hidden shadow-xl"
            style={{
              left: `${pos().left}px`,
              top: `${pos().top}px`,
              transform: pos().up ? "translateY(-100%)" : undefined,
            }}
          >
            <label class="border-base-300 flex items-center gap-2 border-b px-3 py-2">
              <Ico icon="lucide:search" class="text-muted" />
              <input
                ref={input}
                class="w-full bg-transparent text-sm outline-none"
                placeholder="Chercher une catégorie…"
                value={query()}
                onInput={(e) => {
                  setQuery(e.currentTarget.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
                role="combobox"
                aria-controls="cat-picker-list"
                aria-activedescendant={flat()[active()] ? `cat-opt-${flat()[active()].id}` : undefined}
              />
            </label>
            <ul id="cat-picker-list" role="listbox" class="overflow-y-auto p-1.5">
              <For each={groups()}>
                {(g) => (
                  <>
                    <li class="text-muted px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
                      <KindLabel kind={g.kind} />
                    </li>
                    <For each={g.items}>
                      {(c) => {
                        const idx = () => flat().indexOf(c);
                        return (
                          <li
                            id={`cat-opt-${c.id}`}
                            role="option"
                            aria-selected={c.id === props.value}
                            class={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${
                              idx() === active() ? "bg-base-200" : ""
                            }`}
                            onPointerEnter={() => setActive(idx())}
                            onClick={() => choose(c)}
                          >
                            <CategoryIcon category={c} size="sm" />
                            <span class="truncate">{c.name}</span>
                            <Show when={c.id === props.value}>
                              <Ico icon="lucide:check" class="text-primary ml-auto" />
                            </Show>
                          </li>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
              <Show when={flat().length === 0}>
                <li class="text-muted px-3 py-6 text-center text-sm">Aucune catégorie ne correspond.</li>
              </Show>
            </ul>
            <Show when={props.allowClear && props.value != null}>
              <button
                type="button"
                class="border-base-300 hover:bg-base-200 flex items-center gap-2 border-t px-3 py-2 text-left text-sm"
                onClick={() => choose(null)}
              >
                <Ico icon="lucide:rotate-ccw" class="text-muted" />
                Revenir au classement automatique
              </button>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
