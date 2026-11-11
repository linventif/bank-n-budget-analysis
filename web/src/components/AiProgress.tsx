import { A } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";
import { api } from "../api";
import { percent, prettyMerchant } from "../format";
import { errorText, store } from "../store";
import { CategoryIcon, Ico, IconButton } from "./ui";

const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};

/**
 * Avancement de la classification IA, visible sur toutes les pages :
 * barre de progression, temps restant estimé et derniers classements en direct.
 */
export function AiProgress() {
  // Champs absents si le serveur est plus ancien que le frontend : valeurs neutres.
  const p = () => {
    const raw = store.status()?.ai.progress;
    return raw
      ? { ...raw, recent: raw.recent ?? [], batches_total: raw.batches_total ?? 0, batches_done: raw.batches_done ?? 0, failures: raw.failures ?? 0, transactions: raw.transactions ?? 0 }
      : undefined;
  };
  const recentlyFinished = () => {
    const f = p()?.finished_at;
    return !!f && !p()?.running && Date.now() - new Date(f).getTime() < 15 * 60_000 && store.dismissedRun() !== f;
  };
  const visible = () => (p()?.running && (p()?.total ?? 0) > 0) || (recentlyFinished() && (p()?.total ?? 0) > 0);

  const timing = createMemo(() => {
    const prog = p();
    if (!prog?.started_at) return null;
    const end = prog.running ? Date.now() : prog.finished_at ? new Date(prog.finished_at).getTime() : Date.now();
    const elapsed = end - new Date(prog.started_at).getTime();
    // Estimation dès quelques marchands traités (vitesse moyenne depuis le début).
    const remaining = prog.done >= 3 && prog.done < prog.total ? (elapsed / prog.done) * (prog.total - prog.done) : null;
    return { elapsed, remaining };
  });
  const ratio = () => (p()!.total ? p()!.done / p()!.total : 0);
  // État affiché : en cours, arrêtée, en échec (erreur ou lots ratés), terminée.
  const phase = () => {
    const prog = p()!;
    if (prog.running) return "running" as const;
    if (prog.message?.startsWith("Classification arrêtée")) return "stopped" as const;
    if (prog.message?.startsWith("Échec") || prog.failures > 0) return "failed" as const;
    return "done" as const;
  };
  const look = {
    running: { title: "Classification par l'IA en cours", icon: "lucide:sparkles", tone: "bg-primary/12 text-primary" },
    stopped: { title: "Classification arrêtée", icon: "lucide:circle-pause", tone: "bg-base-200 text-ink-2" },
    failed: { title: "Classification incomplète", icon: "lucide:circle-alert", tone: "bg-warning/20" },
    done: { title: "Classification terminée", icon: "lucide:circle-check", tone: "bg-success/12 text-gain" },
  };
  const [stopping, setStopping] = createSignal(false);
  const stop = async () => {
    setStopping(true);
    try {
      await api.cancelClassify();
      store.toast("Arrêt demandé : les classements déjà faits sont conservés");
      store.refreshStatus();
    } catch (e) {
      store.toast(errorText(e), "error");
    } finally {
      setStopping(false);
    }
  };

  return (
    <Show when={visible() && p()}>
      {(prog) => (
        <section class="card-surface mb-5 overflow-hidden" aria-live="polite" aria-label="Avancement de la classification IA">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
            <span class={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-lg ${look[phase()].tone}`}>
              <Ico icon={look[phase()].icon} class={prog().running ? "animate-pulse" : ""} />
            </span>
            <div class="min-w-0 flex-1">
              <div class="font-semibold">{look[phase()].title}</div>
              <div class="text-muted truncate text-xs">
                {prog().model}
                <Show when={prog().batches_total > 0}>
                  {" "}· {prog().batches_done} lot{prog().batches_done > 1 ? "s" : ""} terminé{prog().batches_done > 1 ? "s" : ""} sur {prog().batches_total}
                </Show>
                {" "}· {prog().transactions} opération{prog().transactions > 1 ? "s" : ""} classée{prog().transactions > 1 ? "s" : ""}
                <Show when={prog().failures > 0}>
                  <span class="text-error"> · {prog().failures} lot{prog().failures > 1 ? "s" : ""} en échec</span>
                </Show>
              </div>
            </div>
            <div class="text-right">
              <div class="num text-sm font-semibold">
                {prog().done} / {prog().total} marchands
              </div>
              <div class="text-muted text-xs">
                <Show
                  when={prog().running}
                  fallback={<>en {fmtDuration(timing()?.elapsed ?? 0)}</>}
                >
                  <Show when={timing()?.remaining != null} fallback={<>estimation en cours…</>}>
                    ~{fmtDuration(timing()!.remaining!)} restantes
                  </Show>
                </Show>
              </div>
            </div>
            <Show when={prog().running}>
              <button class="btn btn-sm btn-ghost" onClick={stop} disabled={stopping()} title="Arrêter la classification (les résultats déjà obtenus sont gardés)">
                <Ico icon="lucide:square" /> Arrêter
              </button>
            </Show>
            <Show when={!prog().running}>
              <div class="flex items-center gap-1">
                <Show when={(store.status()?.counts.to_review ?? 0) > 0}>
                  <A href="/operations?source=review" class="btn btn-sm">
                    Vérifier ({store.status()!.counts.to_review})
                  </A>
                </Show>
                <IconButton icon="lucide:x" label="Masquer" onClick={() => store.setDismissedRun(prog().finished_at)} />
              </div>
            </Show>
          </div>

          <Show when={phase() === "failed" && prog().message?.startsWith("Échec")}>
            <p class="text-error px-4 pt-2 text-sm sm:px-5">{prog().message}</p>
          </Show>
          <div class="px-4 pt-3 sm:px-5">
            <div
              class="h-2 overflow-hidden rounded-full"
              style={{ background: "color-mix(in oklab, var(--series-1) 16%, var(--color-base-100))" }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={prog().total}
              aria-valuenow={prog().done}
              aria-valuetext={`${prog().done} marchands sur ${prog().total}`}
            >
              <div
                class="h-full rounded-full transition-[width] duration-700 ease-out"
                style={{ width: `${Math.max(ratio() * 100, prog().running ? 1.5 : 0)}%`, background: "var(--series-1)" }}
              />
            </div>
            <div class="text-muted mt-1 flex justify-between text-[11px]">
              <span>{percent(ratio())}</span>
              <span>{prog().classified} classés · {prog().done - prog().classified} sans réponse exploitable</span>
            </div>
          </div>

          <Show when={prog().recent.length}>
            <div class="border-base-200 mt-3 border-t px-4 py-3 sm:px-5">
              <div class="text-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
                {prog().running ? "En direct" : "Derniers classements"}
              </div>
              <ul class="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                <For each={prog().recent.slice(0, 6)}>
                  {(d, i) => {
                    const cat = () => store.categoryById().get(d.category_id);
                    return (
                      <li class={`flex min-w-0 items-center gap-2.5 text-sm ${i() === 0 && prog().running ? "animate-[fadein_.5s_ease-out]" : ""}`}>
                        <CategoryIcon category={cat()} size="sm" />
                        <span class="min-w-0 flex-1 truncate">
                          <span class="font-medium">{prettyMerchant(d.merchant)}</span>
                          <span class="text-muted"> → {cat()?.name ?? "?"}</span>
                        </span>
                        <span
                          class={`badge badge-xs shrink-0 ${d.confidence < 0.6 ? "badge-warning" : "badge-ghost"}`}
                          title={`Confiance du modèle · ${d.count} opération${d.count > 1 ? "s" : ""}`}
                        >
                          {percent(d.confidence)}
                        </span>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </div>
          </Show>
        </section>
      )}
    </Show>
  );
}
