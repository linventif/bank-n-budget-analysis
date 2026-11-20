import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../api";
import { since, SyncButton } from "../components/Layout";
import { Card, Empty, Ico, Spinner } from "../components/ui";
import { dateTime, daysUntil, money, percent } from "../format";
import { errorText, store } from "../store";

export default function Accounts() {
  const [accounts] = createResource(store.version, () => api.accounts());

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Comptes & IA</h1>
          <p class="text-muted text-sm">
            <Show when={store.status()?.last_sync_message} fallback="Banques connectées via Enable Banking">
              {store.status()!.last_sync_message}
            </Show>
          </p>
        </div>
        <div class="w-44">
          <SyncButton />
        </div>
      </div>

      <Show when={accounts.latest} fallback={<div class="flex justify-center py-16"><Spinner class="loading-md" /></div>}>
        <Show when={accounts.latest!.length} fallback={<Card><Empty icon="lucide:landmark" title="Aucun compte connecté" /></Card>}>
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <For each={accounts.latest}>
              {(a) => {
                const left = () => (a.valid_until ? daysUntil(a.valid_until) : null);
                return (
                  <div class={`card-surface flex flex-col gap-3 p-5 ${a.closed_at ? "opacity-70" : ""}`}>
                    <div class="flex items-center gap-3">
                      <span class="bg-base-200 inline-flex size-10 items-center justify-center rounded-xl text-lg">
                        <Ico icon={a.cash_account_type === "SVGS" ? "lucide:piggy-bank" : "lucide:landmark"} />
                      </span>
                      <div class="min-w-0">
                        <div class="font-semibold">
                          {a.bank}
                          <span class="text-muted font-normal"> · {a.cash_account_type === "SVGS" ? "épargne / pocket" : "compte courant"}</span>
                        </div>
                        <div class="text-muted truncate text-xs">{[a.product, a.iban].filter(Boolean).join(" · ") || a.name}</div>
                      </div>
                    </div>
                    <div>
                      <div class="text-3xl font-semibold">{a.available_cents != null ? money(a.available_cents, a.currency) : "—"}</div>
                      <Show when={a.pending_cents < 0 && a.balance_cents != null}>
                        <div class="text-ink-2 text-xs" title="Opérations autorisées mais pas encore comptabilisées par la banque">
                          {money(-a.pending_cents, a.currency)} en attente déduits · solde banque {money(a.balance_cents!, a.currency)}
                        </div>
                      </Show>
                      <div class="text-muted text-xs">
                        {a.tx_count} opérations · synchronisé {since(a.last_sync)}
                      </div>
                    </div>
                    <Show when={a.last_error}>
                      <div class="text-error flex items-start gap-1.5 text-xs">
                        <Ico icon="lucide:circle-alert" class="mt-0.5" /> {a.last_error}
                      </div>
                    </Show>
                    <Show
                      when={!a.closed_at}
                      fallback={
                        <div class="text-ink-2 flex items-center gap-1.5 text-xs" title="La banque ne renvoie plus ce compte (pocket supprimée…)">
                          <Ico icon="lucide:archive" /> Fermé côté banque · historique conservé
                        </div>
                      }
                    >
                      <div class={`flex items-center gap-1.5 text-xs ${a.expired ? "text-error" : (left() ?? 99) < 15 ? "text-ink-2" : "text-muted"}`}>
                        <Ico icon={a.expired ? "lucide:circle-x" : "lucide:shield-check"} />
                        <Show when={!a.expired} fallback="Accès expiré : reconnecte la banque ci-dessous">
                          Accès autorisé encore {left()} jours
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      <div class="grid gap-5 lg:grid-cols-2">
        <ConnectBank />
        <AiPanel />
      </div>
    </div>
  );
}

function ConnectBank() {
  const [banks] = createResource(() => store.status()?.enable_banking, (ok) => (ok ? api.banks() : Promise.resolve([])));
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    return (banks.latest ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 60);
  });
  const connect = async (name: string, country: string) => {
    setBusy(`${name}|${country}`);
    try {
      const r = await api.connect(name, country);
      window.location.href = r.url;
    } catch (e) {
      store.toast(errorText(e), "error");
      setBusy(null);
    }
  };
  return (
    <Card title="Connecter ou renouveler une banque" subtitle="Tu seras redirigé vers ta banque, puis ramené ici">
      <Show when={store.status()?.enable_banking !== false} fallback={<p class="text-muted text-sm">Enable Banking n'est pas configuré (config.toml).</p>}>
        <label class="input input-sm w-full">
          <Ico icon="lucide:search" class="text-muted" />
          <input type="search" placeholder="Chercher une banque…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <Show when={banks.error}>
          <p class="text-error mt-2 text-sm">{errorText(banks.error)}</p>
        </Show>
        <ul class="mt-2 max-h-72 overflow-y-auto">
          <For each={filtered()}>
            {(b) => (
              <li>
                <button
                  class="hover:bg-base-200 flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm"
                  disabled={busy() != null}
                  onClick={() => connect(b.name, b.country)}
                >
                  <Ico icon="lucide:building-2" class="text-muted" />
                  <span class="flex-1 truncate">{b.name}</span>
                  <span class="badge badge-ghost badge-xs">{b.country}</span>
                  <Show when={b.beta}>
                    <span class="badge badge-warning badge-xs">bêta</span>
                  </Show>
                  <Show when={busy() === `${b.name}|${b.country}`} fallback={<Ico icon="lucide:external-link" class="text-muted" />}>
                    <Spinner class="loading-xs" />
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}

function AiPanel() {
  const ai = () => store.status()?.ai;
  const health = () => ai()?.health;
  const p = () => ai()?.progress;
  const run = async (reclassify: boolean) => {
    try {
      const r = await api.classify(reclassify);
      store.toast(
        `Règles et détection appliquées (${r.stats.rule + r.stats.memory + r.stats.transfer} opérations)` + (r.ai_started ? " · IA lancée" : ""),
        "success",
      );
      store.bump();
      store.refreshStatus();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };

  return (
    <Card
      title={
        <span class="flex items-center gap-2">
          <Ico icon="lucide:sparkles" /> Classification par IA locale
        </span>
      }
      subtitle={`Un petit modèle tourne sur ta machine (${health()?.provider === "ollama" ? "Ollama" : "vLLM"}) : aucun libellé ne quitte l'ordinateur`}
    >
      <div class="flex flex-col gap-4">
        <div class="flex items-center gap-3 text-sm">
          <span
            class={`inline-flex size-2.5 rounded-full ${health()?.model_installed ? "bg-success" : health()?.reachable ? "bg-warning" : "bg-error"}`}
          />
          <span>
            <Show when={health()?.reachable} fallback={`Le serveur IA ne répond pas (${health()?.url ?? "?"})`}>
              <Show
                when={health()?.model_installed}
                fallback={`Serveur actif, mais il sert ${health()?.models.join(", ") || "aucun modèle"} au lieu de ${health()?.model}`}
              >
                Prêt · <span class="font-medium">{health()?.model}</span>
                <span class="text-muted"> via {health()?.provider === "ollama" ? "Ollama" : "vLLM"}</span>
              </Show>
            </Show>
          </span>
        </div>

        <Show when={!health()?.model_installed}>
          <div class="bg-base-200 rounded-box p-4 text-sm">
            <p class="mb-2 font-medium">Pour l'activer :</p>
            <Show
              when={health()?.provider !== "ollama"}
              fallback={
                <ol class="text-ink-2 list-decimal space-y-1 pl-5">
                  <li>
                    Installer Ollama : <code class="text-xs">curl -fsSL https://ollama.com/install.sh | sh</code>
                  </li>
                  <li>
                    Télécharger le modèle : <code class="text-xs">ollama pull {health()?.model}</code>
                  </li>
                </ol>
              }
            >
              <p class="text-ink-2">
                Démarre vLLM : <code class="text-xs">./scripts/vllm.sh start</code>
              </p>
              <p class="text-muted mt-1 text-xs">
                Chargement du modèle : 2 à 4 minutes (plus le téléchargement au premier lancement). Suivi :{" "}
                <code>./scripts/vllm.sh logs</code> · arrêt pour libérer la RAM : <code>./scripts/vllm.sh stop</code>
              </p>
            </Show>
          </div>
        </Show>

        <Show when={p()?.running}>
          <div>
            <div class="mb-1 flex justify-between text-sm">
              <span>Classification en cours…</span>
              <span class="num text-muted">
                {p()!.done}/{p()!.total} marchands
              </span>
            </div>
            <progress class="progress progress-primary w-full" value={p()!.done} max={Math.max(p()!.total, 1)} />
            <p class="text-muted mt-1 text-xs">{p()!.classified} classés · les résultats apparaissent au fil de l'eau</p>
          </div>
        </Show>
        <Show when={!p()?.running && p()?.message}>
          <p class="text-ink-2 text-sm">
            {p()!.message}
            <Show when={p()!.finished_at}>
              <span class="text-muted"> · {dateTime(p()!.finished_at!)}</span>
            </Show>
          </p>
        </Show>

        <div class="flex flex-wrap gap-2">
          <button class="btn btn-sm btn-primary" disabled={p()?.running} onClick={() => run(false)}>
            <Ico icon="lucide:wand-sparkles" /> Classer les opérations sans catégorie
          </button>
          <button
            class="btn btn-sm"
            disabled={p()?.running || !health()?.model_installed}
            onClick={() => run(true)}
            title="Refait les classements de l'IA (tes choix manuels et tes règles ne bougent pas)"
          >
            <Ico icon="lucide:rotate-ccw" /> Tout reclasser
          </button>
        </div>
        <p class="text-muted text-xs">
          Ordre de priorité : tes choix manuels, puis tes règles, puis la mémoire (même marchand), la détection des virements internes, et enfin l'IA.
          <Show when={(store.status()?.counts.transactions ?? 0) > 0}>
            {" "}
            Couverture actuelle :{" "}
            {percent(1 - (store.status()!.counts.uncategorized || 0) / Math.max(store.status()!.counts.transactions, 1))} des opérations classées.
          </Show>
        </p>
      </div>
    </Card>
  );
}
