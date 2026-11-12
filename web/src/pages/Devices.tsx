import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { api } from "../api";
import { Card, Empty, Ico, IconButton, Spinner } from "../components/ui";
import { relative } from "../format";
import { errorText, store } from "../store";
import { deviceLabel } from "../webauthn";

/** Appareils autorisés pour l'accès distant (gestion possible uniquement en local). */
export default function Devices() {
  const [data, { refetch }] = createResource(() => api.devices());
  const [link, setLink] = createSignal<{ url: string; expires_at: string; qr_svg: string } | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const tick = window.setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => window.clearInterval(tick));
  const remaining = () => (link() ? Math.max(0, Math.round((new Date(link()!.expires_at).getTime() - now()) / 1000)) : 0);

  const act = async (p: Promise<unknown>, ok: string) => {
    try {
      await p;
      store.toast(ok, "success");
      refetch();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };
  const newLink = async () => {
    try {
      setLink(await api.enrollLink());
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link()!.url);
      store.toast("Lien copié", "success");
    } catch {
      store.toast("Copie impossible : sélectionne le lien à la main", "error");
    }
  };

  return (
    <div class="flex flex-col gap-5">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Appareils</h1>
        <p class="text-muted text-sm">
          Accès distant sur{" "}
          <a href={store.me()?.public_url} class="link" target="_blank" rel="noreferrer">
            {store.me()?.public_url?.replace(/^https?:\/\//, "")}
          </a>{" "}
          · connexion par passkey uniquement · aucune authentification en local
        </p>
      </div>

      <Show when={store.me()?.public_dashboard === false}>
        <div role="alert" class="alert">
          <Ico icon="lucide:info" /> Le tableau de bord public est désactivé (<code>server.public_dashboard = false</code>).
        </div>
      </Show>

      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="flex flex-col gap-5">
          <Card title="Passkeys" subtitle="Supprimer une passkey déconnecte aussi les appareils qui l'utilisent">
            <Show when={data.latest} fallback={<div class="flex justify-center py-8"><Spinner /></div>}>
              <Show when={data.latest!.passkeys.length} fallback={<Empty icon="lucide:key-round" title="Aucune passkey">Ajoute ton téléphone pour accéder au tableau de bord à distance.</Empty>}>
                <ul class="divide-base-200 divide-y">
                  <For each={data.latest!.passkeys}>
                    {(p) => <PasskeyRow p={p} onRename={(n) => act(api.renamePasskey(p.id, n), "Passkey renommée")} onDelete={() => act(api.deletePasskey(p.id), `« ${p.name} » supprimée`)} />}
                  </For>
                </ul>
              </Show>
            </Show>
          </Card>

          <Card title="Sessions ouvertes" subtitle="Appareils actuellement connectés à distance (30 jours glissants)">
            <Show when={data.latest?.sessions.length} fallback={<p class="text-muted py-4 text-sm">Aucune session à distance.</p>}>
              <ul class="divide-base-200 divide-y">
                <For each={data.latest!.sessions}>
                  {(s) => (
                    <li class="flex items-center gap-3 py-2.5">
                      <span class="bg-base-200 inline-flex size-9 items-center justify-center rounded-xl">
                        <Ico icon={/iPhone|Android|iPad/.test(s.user_agent ?? "") ? "lucide:smartphone" : "lucide:laptop"} />
                      </span>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-medium">{deviceLabel(s.user_agent)}</div>
                        <div class="text-muted truncate text-xs">
                          passkey « {s.passkey_name ?? "?"} » · vu {relative(s.last_seen_at)}
                          <Show when={s.ip}> · {s.ip}</Show>
                        </div>
                      </div>
                      <button class="btn btn-ghost btn-xs" onClick={() => act(api.revokeSession(s.id), "Session fermée")}>
                        Déconnecter
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Card>
        </div>

        <Card title="Ajouter un appareil" subtitle="Lien à usage unique, valable 10 minutes" class="self-start">
          <Show
            when={link() && remaining() > 0}
            fallback={
              <div class="flex flex-col gap-3">
                <p class="text-ink-2 text-sm">
                  Génère un lien, puis scanne le QR code avec ton téléphone (ou ouvre le lien sur l'ordinateur à ajouter). L'appareil créera
                  sa passkey sur l'adresse publique.
                </p>
                <button class="btn btn-primary" onClick={newLink}>
                  <Ico icon="lucide:qr-code" /> Générer un lien d'ajout
                </button>
              </div>
            }
          >
            <div class="flex flex-col items-center gap-3">
              {/* SVG généré par le serveur (uniquement des rectangles) */}
              <div class="rounded-xl bg-white p-3 [&>svg]:size-56" innerHTML={link()!.qr_svg} />
              <p class="text-muted text-xs">
                expire dans {Math.floor(remaining() / 60)}:{String(remaining() % 60).padStart(2, "0")}
              </p>
              <div class="flex w-full gap-2">
                <button class="btn btn-sm flex-1" onClick={copy}>
                  <Ico icon="lucide:copy" /> Copier le lien
                </button>
                <a class="btn btn-sm flex-1" href={link()!.url} target="_blank" rel="noreferrer">
                  <Ico icon="lucide:external-link" /> Ouvrir ici
                </a>
              </div>
              <button class="btn btn-ghost btn-xs" onClick={() => setLink(null)}>
                Annuler
              </button>
            </div>
          </Show>
        </Card>
      </div>
    </div>
  );
}

function PasskeyRow(props: {
  p: { id: number; name: string; created_at: string; last_used_at: string | null };
  onRename: (n: string) => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = createSignal(false);
  return (
    <li class="flex items-center gap-3 py-2.5">
      <span class="bg-base-200 inline-flex size-9 items-center justify-center rounded-xl">
        <Ico icon="lucide:key-round" />
      </span>
      <div class="min-w-0 flex-1">
        <input
          class="input input-ghost input-sm -ml-2 h-7 w-full max-w-xs px-2 font-medium"
          value={props.p.name}
          aria-label="Nom de la passkey"
          onChange={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== props.p.name) props.onRename(v);
          }}
        />
        <div class="text-muted text-xs">
          créée {relative(props.p.created_at)} · {props.p.last_used_at ? `utilisée ${relative(props.p.last_used_at)}` : "jamais utilisée"}
        </div>
      </div>
      <Show when={confirm()} fallback={<IconButton icon="lucide:trash-2" label="Supprimer" class="text-muted" onClick={() => setConfirm(true)} />}>
        <button class="btn btn-error btn-xs" onClick={props.onDelete} onBlur={() => setConfirm(false)}>
          Supprimer
        </button>
      </Show>
    </li>
  );
}
