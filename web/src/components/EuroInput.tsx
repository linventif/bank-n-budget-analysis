import { createEffect, createSignal } from "solid-js";
import { formatEuros, parseEuros } from "../budget";

/**
 * Montant en euros façon tableur : affiche « 550 » ou « 2,5 », accepte virgule ou point,
 * enregistre à la sortie du champ ou sur Entrée (vide = aucun montant).
 */
export function EuroInput(props: {
  value: number | null | undefined;
  onCommit: (cents: number | null) => void;
  label: string;
  class?: string;
  placeholder?: string;
}) {
  const [text, setText] = createSignal(formatEuros(props.value));
  const [invalid, setInvalid] = createSignal(false);
  let focused = false;
  createEffect(() => {
    const v = formatEuros(props.value);
    if (!focused) setText(v);
  });
  const commit = () => {
    const parsed = parseEuros(text());
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== (props.value ?? null)) props.onCommit(parsed);
    setText(formatEuros(parsed));
  };
  return (
    <input
      type="text"
      inputmode="decimal"
      aria-label={props.label}
      aria-invalid={invalid()}
      placeholder={props.placeholder ?? "—"}
      class={`num w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-right text-sm outline-none hover:border-[var(--hairline)] focus:border-[var(--series-1)] focus:bg-[var(--color-base-100)] ${
        invalid() ? "!border-[var(--color-error)]" : ""
      } ${props.class ?? ""}`}
      value={text()}
      onFocus={(e) => {
        focused = true;
        e.currentTarget.select();
      }}
      onInput={(e) => setText(e.currentTarget.value)}
      onBlur={() => {
        focused = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(formatEuros(props.value));
          setInvalid(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
