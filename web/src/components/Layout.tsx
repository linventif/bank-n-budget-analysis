import { A, useLocation } from "@solidjs/router";
import { createSignal, For, Show, type JSX } from "solid-js";
import { api } from "../api";
import { percent, relative } from "../format";
import { errorText, store } from "../store";
import { AiProgress } from "./AiProgress";
import { Ico, Spinner } from "./ui";

const NAV = [
  { href: "/", icon: "lucide:layout-dashboard", label: "Tableau de bord", end: true },
  { href: "/budget", icon: "lucide:calculator", label: "Budget" },
  { href: "/operations", icon: "lucide:list", label: "Opérations" },
  { href: "/calendrier", icon: "lucide:calendar-days", label: "Calendrier" },
  { href: "/tendances", icon: "lucide:chart-column", label: "Tendances" },
  { href: "/bourse", icon: "lucide:chart-candlestick", label: "Bourse" },
  { href: "/categories", icon: "lucide:tags", label: "Catégories" },
  { href: "/comptes", icon: "lucide:wallet", label: "Comptes & IA" },
];

export function Layout(props: { children?: JSX.Element }) {
  const [drawer, setDrawer] = createSignal(false);
  const location = useLocation();
  const title = () => NAV.find((n) => (n.end ? location.pathname === n.href : location.pathname.startsWith(n.href)))?.label ?? "bks";

  return (
    <div class="drawer lg:drawer-open">
      <input id="nav-drawer" type="checkbox" class="drawer-toggle" checked={drawer()} onChange={(e) => setDrawer(e.currentTarget.checked)} />
      <div class="drawer-content flex min-h-dvh flex-col">
        {/* Barre du haut (mobile) */}
        <header class="bg-base-100/90 border-base-300 sticky top-0 z-30 flex items-center gap-2 border-b px-3 py-2 backdrop-blur lg:hidden">
          <label for="nav-drawer" class="btn btn-ghost btn-sm btn-square" aria-label="Ouvrir le menu">
            <Ico icon="lucide:menu" class="text-lg" />
          </label>
          <span class="font-semibold">{title()}</span>
          <div class="ml-auto">
            <SyncButton compact />
          </div>
        </header>
        <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
          <AiProgress />
          {props.children}
        </main>
      </div>

      <div class="drawer-side z-40">
        <label for="nav-drawer" aria-label="Fermer le menu" class="drawer-overlay" />
        <aside class="bg-base-100 border-base-300 flex min-h-full w-64 flex-col border-r">
          <div class="flex items-center gap-2.5 px-5 pt-6 pb-5">
            <span class="bg-primary text-primary-content inline-flex size-8 items-center justify-center rounded-lg">
              <Ico icon="lucide:wallet" />
            </span>
            <div class="leading-tight">
              <div class="font-semibold">bks</div>
              <div class="text-muted text-xs">Mes comptes</div>
            </div>
          </div>
          <ul class="menu w-full gap-0.5 px-3">
            <For each={store.me()?.local ? [...NAV, { href: "/appareils", icon: "lucide:key-round", label: "Appareils" }] : NAV}>
              {(n) => (
                <li>
                  <A href={n.href} end={n.end} activeClass="menu-active" onClick={() => setDrawer(false)} class="gap-3">
                    <Ico icon={n.icon} class="text-base" />
                    {n.label}
                    <Show when={n.href === "/operations" && (store.status()?.counts.to_review ?? 0) > 0}>
                      <span class="badge badge-warning badge-xs ml-auto" title="Classements IA peu sûrs">
                        {store.status()!.counts.to_review}
                      </span>
                    </Show>
                  </A>
                </li>
              )}
            </For>
          </ul>

          <div class="mt-auto flex flex-col gap-3 p-4">
            <AiPill />
            <SyncButton />
            <ThemeSwitch />
            <Show when={store.me() && !store.me()!.local}>
              <button class="btn btn-ghost btn-sm w-full justify-start" onClick={() => store.logout()}>
                <Ico icon="lucide:log-out" /> Se déconnecter
              </button>
            </Show>
          </div>
        </aside>
      </div>
    </div>
  );
}

function AiPill() {
  const s = () => store.status();
  return (
    <A href="/comptes" class="card-surface hover:bg-base-200 flex items-center gap-3 px-3 py-2.5 text-sm">
      <Show
        when={s()?.ai.progress.running}
        fallback={
          <span
            class={`inline-flex size-2 rounded-full ${
              s()?.ai.health?.model_installed ? "bg-success" : s()?.ai.health?.reachable ? "bg-warning" : "bg-base-300"
            }`}
          />
        }
      >
        <Spinner class="loading-xs" />
      </Show>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 font-medium">
          <Ico icon="lucide:sparkles" class="text-xs" />
          IA locale
        </div>
        <div class="text-muted truncate text-xs">
          {s()?.ai.progress.running
            ? `${s()!.ai.progress.done}/${s()!.ai.progress.total} marchands`
            : s()?.ai.health?.model_installed
              ? s()!.ai.health!.model
              : s()?.ai.health?.reachable
                ? "modèle non servi"
                : `${s()?.ai.health?.provider === "ollama" ? "Ollama" : "vLLM"} arrêté`}
        </div>
      </div>
      <Show when={s()?.ai.progress.running && s()!.ai.progress.total > 0}>
        <span class="num text-muted text-xs">{percent(s()!.ai.progress.done / s()!.ai.progress.total)}</span>
      </Show>
    </A>
  );
}

export function SyncButton(props: { compact?: boolean }) {
  const syncing = () => store.status()?.syncing ?? false;
  const run = async () => {
    try {
      await api.sync();
      store.toast("Synchronisation lancée");
      store.refreshStatus();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };
  const lastSync = () => store.status()?.last_sync_message;
  return (
    <button
      type="button"
      class={`btn ${props.compact ? "btn-ghost btn-sm btn-square" : "btn-sm w-full justify-start"}`}
      disabled={syncing()}
      onClick={run}
      title={lastSync() ?? "Récupérer les dernières opérations"}
      aria-label="Synchroniser"
    >
      <Ico icon="lucide:refresh-cw" class={syncing() ? "animate-spin" : ""} />
      <Show when={!props.compact}>{syncing() ? "Synchronisation…" : "Synchroniser"}</Show>
    </button>
  );
}

function ThemeSwitch() {
  const opts = [
    { v: "light", icon: "lucide:sun", label: "Clair" },
    { v: "system", icon: "lucide:monitor", label: "Système" },
    { v: "dark", icon: "lucide:moon", label: "Sombre" },
  ] as const;
  return (
    <div class="join w-full" role="radiogroup" aria-label="Thème">
      <For each={opts}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={store.theme() === o.v}
            class={`btn btn-xs join-item flex-1 ${store.theme() === o.v ? "btn-active" : "btn-ghost"}`}
            title={o.label}
            onClick={() => store.setTheme(o.v)}
          >
            <Ico icon={o.icon} />
          </button>
        )}
      </For>
    </div>
  );
}

export function Toasts() {
  return (
    <div class="toast toast-end toast-bottom z-50" aria-live="polite">
      <For each={store.toasts()}>
        {(t) => (
          <div
            role={t.kind === "error" ? "alert" : "status"}
            class={`alert ${t.kind === "error" ? "alert-error" : "bg-neutral text-neutral-content border-0"} max-w-sm shadow-lg`}
          >
            <Ico icon={t.kind === "error" ? "lucide:circle-alert" : t.kind === "success" ? "lucide:circle-check" : "lucide:info"} />
            <span class="text-sm">{t.text}</span>
            <Show when={t.action}>
              <button
                type="button"
                class="btn btn-xs btn-primary"
                onClick={() => {
                  t.action!.run();
                  store.dismiss(t.id);
                }}
              >
                {t.action!.label}
              </button>
            </Show>
            <button type="button" class="btn btn-ghost btn-xs btn-square" aria-label="Fermer" onClick={() => store.dismiss(t.id)}>
              <Ico icon="lucide:x" />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

/** Pour les écrans qui affichent l'âge d'une info : « il y a 5 min ». */
export const since = (iso: string | null | undefined) => (iso ? relative(iso) : "jamais");
