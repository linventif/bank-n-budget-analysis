// Cérémonies WebAuthn : conversion entre le JSON du serveur (base64url) et l'API du navigateur.

import { api } from "./api";

const fromB64url = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const toB64url = (buf: ArrayBuffer | null | undefined): string | undefined => {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Json = Record<string, unknown>;
type CredDesc = { id: string; type: string; transports?: AuthenticatorTransport[] };

const decodeCreation = (pk: Json): PublicKeyCredentialCreationOptions => {
  const user = pk.user as Json;
  return {
    ...(pk as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromB64url(pk.challenge as string),
    user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: fromB64url(user.id as string) },
    excludeCredentials: ((pk.excludeCredentials as CredDesc[] | undefined) ?? []).map((c) => ({
      ...c,
      type: "public-key" as const,
      id: fromB64url(c.id),
    })),
  };
};

const decodeRequest = (pk: Json): PublicKeyCredentialRequestOptions => ({
  ...(pk as unknown as PublicKeyCredentialRequestOptions),
  challenge: fromB64url(pk.challenge as string),
  allowCredentials: ((pk.allowCredentials as CredDesc[] | undefined) ?? []).map((c) => ({
    ...c,
    type: "public-key" as const,
    id: fromB64url(c.id),
  })),
});

export const webauthnSupported = () => typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials;

/** Message compréhensible pour les erreurs courantes du navigateur. */
export const webauthnError = (e: unknown) => {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return "Opération annulée ou délai dépassé.";
  if (name === "InvalidStateError") return "Cet appareil a déjà une passkey pour bks.";
  if (name === "SecurityError") return "Le navigateur refuse : la page doit être ouverte sur l'adresse publique en HTTPS.";
  return e instanceof Error ? e.message : String(e);
};

/** Crée une passkey sur cet appareil avec un jeton d'ajout ; ouvre la session en cas de succès. */
export async function registerPasskey(token: string, name: string) {
  const { id, options } = await api.registerStart(token);
  const cred = (await navigator.credentials.create({ publicKey: decodeCreation(options.publicKey) })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Aucune passkey créée.");
  const res = cred.response as AuthenticatorAttestationResponse;
  await api.registerFinish(id, token, name, {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: toB64url(res.attestationObject),
      clientDataJSON: toB64url(res.clientDataJSON),
      transports: typeof res.getTransports === "function" ? res.getTransports() : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  });
}

/** Connexion avec une passkey déjà enregistrée (sur cet appareil ou un téléphone à proximité). */
export async function loginWithPasskey() {
  const { id, options } = await api.loginStart();
  const cred = (await navigator.credentials.get({ publicKey: decodeRequest(options.publicKey) })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Aucune passkey utilisée.");
  const res = cred.response as AuthenticatorAssertionResponse;
  await api.loginFinish(id, {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: toB64url(res.authenticatorData),
      clientDataJSON: toB64url(res.clientDataJSON),
      signature: toB64url(res.signature),
      userHandle: toB64url(res.userHandle),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  });
}

/** Nom d'appareil lisible à partir du navigateur : « iPhone · Safari », « Windows · Chrome »… */
export function deviceLabel(ua: string | null | undefined) {
  if (!ua) return "Appareil inconnu";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Appareil";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua) && !/Chromium/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return browser ? `${os} · ${browser}` : os;
}
