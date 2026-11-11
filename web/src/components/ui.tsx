import { Icon } from "@iconify-icon/solid";
import { Show, type JSX, splitProps } from "solid-js";
import type { Category, Kind, Source } from "../api";
import { percent } from "../format";

export function Ico(props: { icon: string; class?: string; label?: string }) {
  return (
    <Icon
      icon={props.icon}
      class={props.class}
      aria-hidden={props.label ? undefined : "true"}
      aria-label={props.label}
      role={props.label ? "img" : undefined}
    />
  );
}

const kindTone: Record<Kind, string> = {
  expense: "bg-base-200 text-base-content",
  income: "bg-success/12 text-gain",
  transfer: "bg-base-200 text-muted",
};

/** Icône de catégorie dans un carré arrondi ; « non classé » si absente. */
export function CategoryIcon(props: { category?: Category | null; size?: "sm" | "md" | "lg" }) {
  const box = () =>
    ({ sm: "size-7 text-[15px] rounded-lg", md: "size-9 text-lg rounded-xl", lg: "size-11 text-xl rounded-xl" })[
      props.size ?? "md"
    ];
  return (
    <span
      class={`inline-flex shrink-0 items-center justify-center ${box()} ${
        props.category ? kindTone[props.category.kind] : "border border-dashed border-base-300 text-muted"
      }`}
    >
      <Ico icon={props.category?.icon ?? "lucide:circle-help"} />
    </span>
  );
}

const sourceLabel: Record<Source, string> = {
  user: "Manuel",
  rule: "Règle",
  memory: "Mémoire",
  transfer: "Auto",
  ai: "IA",
};
const sourceHelp: Record<Source, string> = {
  user: "Catégorie choisie à la main",
  rule: "Appliquée par une de tes règles",
  memory: "Même marchand qu'une opération que tu as classée",
  transfer: "Virement entre tes comptes, détecté automatiquement",
  ai: "Proposée par le modèle local",
};

export function SourceBadge(props: { source: Source | null; confidence: number | null }) {
  return (
    <Show when={props.source}>
      {(s) => {
        const low = () => s() === "ai" && (props.confidence ?? 0) < 0.6;
        return (
          <span
            class={`badge badge-xs gap-1 whitespace-nowrap ${low() ? "badge-warning" : "badge-ghost"}`}
            title={sourceHelp[s()] + (s() === "ai" && props.confidence != null ? ` · confiance ${percent(props.confidence)}` : "")}
          >
            <Show when={s() === "ai"}>
              <Ico icon="lucide:sparkles" class="text-[10px]" />
            </Show>
            {low() ? "À vérifier" : sourceLabel[s()]}
            <Show when={s() === "ai" && !low() && props.confidence != null}>
              <span class="opacity-70">{percent(props.confidence!)}</span>
            </Show>
          </span>
        );
      }}
    </Show>
  );
}

/**
 * Écart à une référence. La couleur dépend du sens ET de ce qui est souhaitable
 * (pour des dépenses, une hausse est défavorable) ; toujours accompagnée d'une icône et d'un texte.
 */
export function Delta(props: { value: number; reference: number; upIsGood: boolean; suffix?: string }) {
  const ratio = () => (props.reference === 0 ? null : (props.value - props.reference) / Math.abs(props.reference));
  return (
    <Show when={ratio() !== null} fallback={<span class="text-muted text-sm">—</span>}>
      {(_) => {
        const r = () => ratio()!;
        const flat = () => Math.abs(r()) < 0.02;
        const good = () => (r() > 0) === props.upIsGood;
        return (
          <span
            class={`inline-flex items-center gap-1 text-sm font-medium ${
              flat() ? "text-ink-2" : good() ? "text-gain" : "text-error"
            }`}
          >
            <Ico icon={flat() ? "lucide:minus" : r() > 0 ? "lucide:trending-up" : "lucide:trending-down"} />
            {flat() ? "stable" : `${r() > 0 ? "+" : "−"}${percent(Math.abs(r()))}`}
            <Show when={props.suffix}>
              <span class="text-muted font-normal">{props.suffix}</span>
            </Show>
          </span>
        );
      }}
    </Show>
  );
}

export function Card(props: { title?: JSX.Element; subtitle?: JSX.Element; actions?: JSX.Element; class?: string; children: JSX.Element }) {
  return (
    <section class={`card-surface min-w-0 p-4 sm:p-5 ${props.class ?? ""}`}>
      <Show when={props.title || props.actions}>
        <header class="mb-4 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-[15px] font-semibold leading-tight">{props.title}</h2>
            <Show when={props.subtitle}>
              <p class="text-muted mt-0.5 text-sm">{props.subtitle}</p>
            </Show>
          </div>
          <Show when={props.actions}>
            <div class="flex shrink-0 items-center gap-2">{props.actions}</div>
          </Show>
        </header>
      </Show>
      {props.children}
    </section>
  );
}

export function Empty(props: { icon: string; title: string; children?: JSX.Element }) {
  return (
    <div class="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <span class="bg-base-200 text-muted inline-flex size-12 items-center justify-center rounded-2xl text-2xl">
        <Ico icon={props.icon} />
      </span>
      <p class="font-medium">{props.title}</p>
      <Show when={props.children}>
        <div class="text-muted max-w-sm text-sm">{props.children}</div>
      </Show>
    </div>
  );
}

export function Spinner(props: { class?: string }) {
  return <span class={`loading loading-spinner ${props.class ?? "loading-sm"}`} />;
}

export function KindLabel(props: { kind: Kind }) {
  return <>{{ expense: "Dépenses", income: "Revenus", transfer: "Virements & épargne" }[props.kind]}</>;
}

export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  const [local, rest] = splitProps(props, ["icon", "label", "class"]);
  return (
    <button type="button" class={`btn btn-ghost btn-sm btn-square ${local.class ?? ""}`} aria-label={local.label} title={local.label} {...rest}>
      <Ico icon={local.icon} class="text-base" />
    </button>
  );
}
