import { createSignal, Show } from "solid-js";
import { Ico, Spinner } from "../components/ui";
import { store } from "../store";
import { loginWithPasskey, webauthnError, webauthnSupported } from "../webauthn";

/** Écran de connexion de l'accès distant : passkey uniquement. */
export default function Login() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      await store.afterLogin();
    } catch (e) {
      setError(webauthnError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <h1 class="text-xl font-semibold">Connexion</h1>
      <p class="text-muted mt-1 text-sm">Accès réservé, avec une passkey enregistrée sur ton téléphone ou ton ordinateur.</p>
      <Show
        when={webauthnSupported()}
        fallback={<p class="text-error mt-6 text-sm">Ce navigateur ne gère pas les passkeys.</p>}
      >
        <button class="btn btn-primary btn-block mt-6" onClick={login} disabled={busy()} autofocus>
          <Show when={busy()} fallback={<Ico icon="lucide:key-round" />}>
            <Spinner class="loading-xs" />
          </Show>
          Se connecter avec une passkey
        </button>
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-error mt-3 flex items-start gap-1.5 text-sm">
          <Ico icon="lucide:circle-alert" class="mt-0.5" /> {error()}
        </p>
      </Show>
      <Show when={store.me() && !store.me()!.has_passkeys}>
        <p class="text-muted mt-4 text-sm">Aucun appareil n'est encore enregistré.</p>
      </Show>
      <div class="border-base-200 text-muted mt-6 border-t pt-4 text-xs leading-relaxed">
        <p class="mb-1 font-medium">Nouvel appareil ?</p>
        Sur l'ordinateur qui héberge bks, ouvre <code>localhost:9890</code> → <span class="text-ink-2">Appareils</span> →{" "}
        <span class="text-ink-2">Ajouter un appareil</span>, puis scanne le QR code. Depuis un ordinateur sans passkey, tu peux aussi
        te connecter avec ton téléphone : le navigateur te le proposera.
      </div>
    </AuthShell>
  );
}

export function AuthShell(props: { children: import("solid-js").JSX.Element }) {
  return (
    <main class="flex min-h-dvh items-center justify-center p-4">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex items-center justify-center gap-2.5">
          <span class="bg-primary text-primary-content inline-flex size-9 items-center justify-center rounded-xl text-lg">
            <Ico icon="lucide:wallet" />
          </span>
          <span class="text-lg font-semibold">bks</span>
        </div>
        <section class="card-surface p-6">{props.children}</section>
        <p class="text-muted mt-4 text-center text-xs">
          <a href="/privacy" class="link">Confidentialité</a> · <a href="/terms" class="link">Conditions</a>
        </p>
      </div>
    </main>
  );
}
