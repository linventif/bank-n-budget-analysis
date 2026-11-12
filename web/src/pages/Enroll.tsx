import { useNavigate } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { Ico, Spinner } from "../components/ui";
import { store } from "../store";
import { deviceLabel, registerPasskey, webauthnError, webauthnSupported } from "../webauthn";
import { AuthShell } from "./Login";

/** Page ouverte via le lien / QR code généré en local : crée la passkey de cet appareil. */
export default function Enroll() {
  // Jeton dans le fragment (#t=…) : il n'est jamais envoyé au serveur avec la page.
  const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
  const navigate = useNavigate();
  const [name, setName] = createSignal(deviceLabel(navigator.userAgent));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);

  const enroll = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(token, name().trim());
      setDone(true);
      // Le jeton est consommé : on quitte /enroll (via le routeur, qui suit l'adresse) puis on ouvre la session.
      setTimeout(async () => {
        await store.afterLogin();
        navigate("/", { replace: true });
      }, 1200);
    } catch (err) {
      setError(webauthnError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <Show
        when={!done()}
        fallback={
          <div class="text-center">
            <span class="bg-success/12 text-gain mx-auto inline-flex size-12 items-center justify-center rounded-2xl text-2xl">
              <Ico icon="lucide:circle-check" />
            </span>
            <h1 class="mt-3 text-xl font-semibold">Appareil ajouté</h1>
            <p class="text-muted mt-1 text-sm">Ouverture du tableau de bord…</p>
          </div>
        }
      >
        <h1 class="text-xl font-semibold">Ajouter cet appareil</h1>
        <p class="text-muted mt-1 text-sm">
          Une passkey va être créée sur cet appareil (Face ID, empreinte, code). Elle servira à te connecter, sans mot de passe.
        </p>
        <Show when={token} fallback={<p class="text-error mt-6 text-sm">Lien incomplet : régénère-le depuis l'ordinateur.</p>}>
          <Show when={webauthnSupported()} fallback={<p class="text-error mt-6 text-sm">Ce navigateur ne gère pas les passkeys.</p>}>
            <form class="mt-5" onSubmit={enroll}>
              <fieldset class="fieldset py-0">
                <legend class="fieldset-legend">Nom de l'appareil</legend>
                <input class="input w-full" value={name()} onInput={(e) => setName(e.currentTarget.value)} maxLength={60} required />
              </fieldset>
              <button class="btn btn-primary btn-block mt-4" disabled={busy() || !name().trim()}>
                <Show when={busy()} fallback={<Ico icon="lucide:key-round" />}>
                  <Spinner class="loading-xs" />
                </Show>
                Créer la passkey
              </button>
            </form>
          </Show>
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-error mt-3 flex items-start gap-1.5 text-sm">
            <Ico icon="lucide:circle-alert" class="mt-0.5" /> {error()}
          </p>
        </Show>
        <p class="text-muted mt-5 text-xs">Le lien est à usage unique et expire 10 minutes après sa création.</p>
      </Show>
    </AuthShell>
  );
}
