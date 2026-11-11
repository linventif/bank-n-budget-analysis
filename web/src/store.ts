// État global : version des données, catégories, statut (synchro / IA), notifications, thème.

import { createMemo, createResource, createRoot, createSignal, onCleanup } from "solid-js";
import { api, type Category, type Status } from "./api";

export type Toast = { id: number; kind: "info" | "success" | "error"; text: string; action?: { label: string; run: () => void } };

export const store = createRoot(() => {
  // Incrémentée après chaque modification ou fin de tâche : toutes les ressources se rechargent.
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  const [categories, { mutate: mutateCategories }] = createResource(version, () => api.categories(), {
    initialValue: [] as Category[],
  });
  const categoryById = createMemo(() => new Map(categories().map((c) => [c.id, c])));

  // --- Statut, interrogé plus souvent pendant une synchro ou une classification ---
  const [status, setStatus] = createSignal<Status | null>(null);
  let timer: number | undefined;
  let wasBusy = false;
  let lastLiveBump = 0;
  const poll = async () => {
    window.clearTimeout(timer);
    try {
      const s = await api.status();
      const busy = s.syncing || s.ai.progress.running;
      if (wasBusy && !busy) bump();
      // Pendant la classification IA, rafraîchir les données au plus toutes les 15 s.
      const prev = status();
      if (s.ai.progress.running && prev && s.ai.progress.classified !== prev.ai.progress.classified && Date.now() - lastLiveBump > 15000) {
        lastLiveBump = Date.now();
        bump();
      }
      wasBusy = busy;
      setStatus(s);
      timer = window.setTimeout(poll, busy ? 2000 : 30000);
    } catch {
      timer = window.setTimeout(poll, 10000);
    }
  };
  poll();
  onCleanup(() => window.clearTimeout(timer));

  // --- Notifications ---
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let nextId = 1;
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const toast = (text: string, kind: Toast["kind"] = "info", action?: Toast["action"]) => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, kind, text, action }]);
    window.setTimeout(() => dismiss(id), action ? 8000 : 4500);
  };

  // --- Thème ---
  type Theme = "system" | "light" | "dark";
  const read = (): Theme => {
    try {
      const v = localStorage.getItem("bks-theme");
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  };
  const [theme, setThemeSignal] = createSignal<Theme>(read());
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const t = theme();
    const dark = t === "dark" || (t === "system" && media.matches);
    document.documentElement.setAttribute("data-theme", dark ? "bks-dark" : "bks");
  };
  media.addEventListener("change", apply);
  const setTheme = (t: Theme) => {
    setThemeSignal(t);
    try {
      if (t === "system") localStorage.removeItem("bks-theme");
      else localStorage.setItem("bks-theme", t);
    } catch {
      /* stockage indisponible : le choix vaut pour la session */
    }
    apply();
  };

  // Panneau « classification terminée » masqué par l'utilisateur (identifié par sa date de fin).
  const [dismissedRun, setDismissedRun] = createSignal<string | null>(null);

  return {
    dismissedRun,
    setDismissedRun,
    version,
    bump,
    categories,
    mutateCategories,
    categoryById,
    status,
    refreshStatus: poll,
    toasts,
    toast,
    dismiss,
    theme,
    setTheme,
  };
});

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
