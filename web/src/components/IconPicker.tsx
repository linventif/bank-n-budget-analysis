import lucide from "@iconify-json/lucide/icons.json";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Ico } from "./ui";

const NAMES = Object.keys(lucide.icons).sort();
const SUGGESTED = [
  "shopping-cart", "utensils", "coffee", "pizza", "beer", "house", "zap", "droplet", "wifi", "smartphone", "train-front",
  "bus", "bike", "car", "fuel", "plane", "hotel", "repeat", "tv", "music", "gamepad-2", "shopping-bag", "shirt", "hammer",
  "sofa", "heart-pulse", "pill", "dumbbell", "ticket", "book-open", "sparkles", "scissors", "graduation-cap", "baby", "gift",
  "heart-handshake", "landmark", "receipt-text", "shield-check", "banknote", "calendar-clock", "paw-print", "briefcase-business",
  "hand-coins", "undo-2", "coins", "arrow-left-right", "piggy-bank", "trending-up", "bitcoin", "cloud", "cpu", "code",
  "stethoscope", "glasses", "tent", "mountain", "camera", "palette", "circle-ellipsis",
];

/** Sélecteur d'icône (jeu Lucide embarqué, hors ligne). Les autres jeux Iconify restent saisissables à la main. */
export function IconPicker(props: { value: string; onChange: (icon: string) => void }) {
  let dialog!: HTMLDialogElement;
  const [query, setQuery] = createSignal("");
  const [custom, setCustom] = createSignal("");
  const results = createMemo(() => {
    const q = query().trim().toLowerCase().replace(/\s+/g, "-");
    const list = q ? NAMES.filter((n) => n.includes(q)) : SUGGESTED;
    return list.slice(0, 180);
  });
  const pick = (icon: string) => {
    props.onChange(icon);
    dialog.close();
  };

  return (
    <>
      <button
        type="button"
        class="btn btn-square btn-ghost border-base-300 border text-xl"
        title="Changer l'icône"
        aria-label="Changer l'icône"
        onClick={() => {
          setQuery("");
          setCustom(props.value.startsWith("lucide:") ? "" : props.value);
          dialog.showModal();
        }}
      >
        <Ico icon={props.value} />
      </button>
      <dialog ref={dialog} class="modal">
        <div class="modal-box max-w-xl">
          <h3 class="mb-3 font-semibold">Choisir une icône</h3>
          <label class="input w-full">
            <Ico icon="lucide:search" class="text-muted" />
            <input
              type="search"
              placeholder="Chercher (en anglais : cart, food, train…)"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              autofocus
            />
          </label>
          <div class="mt-3 grid max-h-80 grid-cols-6 gap-1 overflow-y-auto sm:grid-cols-9">
            <For each={results()}>
              {(n) => (
                <button
                  type="button"
                  class={`btn btn-ghost btn-square text-xl ${props.value === `lucide:${n}` ? "btn-active" : ""}`}
                  title={n}
                  aria-label={n}
                  onClick={() => pick(`lucide:${n}`)}
                >
                  <Ico icon={`lucide:${n}`} />
                </button>
              )}
            </For>
          </div>
          <Show when={results().length === 0}>
            <p class="text-muted py-6 text-center text-sm">Aucune icône Lucide ne correspond.</p>
          </Show>
          <form
            class="border-base-300 mt-4 flex items-center gap-2 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^[a-z0-9-]+:[a-z0-9-]+$/.test(custom().trim())) pick(custom().trim());
            }}
          >
            <span class="text-muted text-xs whitespace-nowrap">Autre jeu Iconify</span>
            <input
              class="input input-sm flex-1"
              placeholder="ex. mdi:food-croissant"
              value={custom()}
              onInput={(e) => setCustom(e.currentTarget.value)}
            />
            <button class="btn btn-sm" type="submit">
              Utiliser
            </button>
          </form>
          <div class="modal-action mt-3">
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => dialog.close()}>
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
