//! Accès distant au tableau de bord : passkeys (WebAuthn) uniquement.
//!
//! - Une passkey ne peut être créée qu'avec un jeton d'enrôlement à usage unique (10 min),
//!   généré depuis l'interface locale : avoir accès à la machine = pouvoir ajouter un appareil.
//! - La connexion produit un jeton de session aléatoire (256 bits) posé en cookie `__Host-` ;
//!   seul son SHA-256 est stocké. Durée : 30 jours glissants.
//! - Les états de cérémonie WebAuthn restent en mémoire côté serveur (jamais envoyés au client).

use crate::db;
use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use webauthn_rs::prelude::*;

pub const COOKIE: &str = "__Host-bks";
pub const SESSION_DAYS: i64 = 30;
const CHALLENGE_TTL: Duration = Duration::from_secs(180);
pub const ENROLL_TTL: Duration = Duration::from_secs(600);
/// Borne la mémoire utilisée par des cérémonies commencées et jamais finies.
const MAX_PENDING: usize = 64;

pub struct Auth {
    webauthn: Webauthn,
    registrations: Mutex<HashMap<String, (Instant, PasskeyRegistration)>>,
    logins: Mutex<HashMap<String, (Instant, PasskeyAuthentication)>>,
    /// SHA-256 du jeton d'enrôlement → expiration.
    enroll: Mutex<HashMap<String, Instant>>,
}

pub fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("générateur aléatoire du système indisponible");
    hex(&b)
}

pub fn hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn put<T>(map: &Mutex<HashMap<String, (Instant, T)>>, value: T) -> String {
    let mut m = map.lock().unwrap();
    m.retain(|_, (at, _)| at.elapsed() < CHALLENGE_TTL);
    if m.len() >= MAX_PENDING {
        if let Some(oldest) = m.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
            m.remove(&oldest);
        }
    }
    let id = random_token();
    m.insert(id.clone(), (Instant::now(), value));
    id
}

fn take<T>(map: &Mutex<HashMap<String, (Instant, T)>>, id: &str) -> Option<T> {
    let (at, v) = map.lock().unwrap().remove(id)?;
    (at.elapsed() < CHALLENGE_TTL).then_some(v)
}

fn wa(e: WebauthnError) -> anyhow::Error {
    anyhow!("WebAuthn : {e:?}")
}

impl Auth {
    pub fn new(public_url: &str) -> Result<Self> {
        let origin = Url::parse(public_url).context("server.public_url invalide")?;
        let rp_id = origin.host_str().context("server.public_url sans nom d'hôte")?.to_string();
        let webauthn = WebauthnBuilder::new(&rp_id, &origin)
            .map_err(wa)?
            .rp_name("bks")
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(wa)?;
        Ok(Self {
            webauthn,
            registrations: Mutex::default(),
            logins: Mutex::default(),
            enroll: Mutex::default(),
        })
    }

    // ---------- Jetons d'enrôlement (créés uniquement depuis l'interface locale) ----------

    pub fn new_enroll_token(&self) -> String {
        let token = random_token();
        let mut m = self.enroll.lock().unwrap();
        m.retain(|_, exp| *exp > Instant::now());
        m.insert(hash(&token), Instant::now() + ENROLL_TTL);
        token
    }

    fn enroll_valid(&self, token: &str) -> bool {
        self.enroll.lock().unwrap().get(&hash(token)).is_some_and(|exp| *exp > Instant::now())
    }

    fn consume_enroll(&self, token: &str) -> bool {
        self.enroll.lock().unwrap().remove(&hash(token)).is_some_and(|exp| exp > Instant::now())
    }

    // ---------- Enregistrement d'une passkey ----------

    pub fn start_registration(&self, conn: &Connection, token: &str) -> Result<(String, CreationChallengeResponse)> {
        if !self.enroll_valid(token) {
            bail!("lien d'ajout invalide ou expiré : génère-en un nouveau depuis l'ordinateur");
        }
        let existing: Vec<CredentialID> = load_passkeys(conn)?.into_iter().map(|(_, pk)| pk.cred_id().clone()).collect();
        let (options, state) = self
            .webauthn
            .start_passkey_registration(user_id(conn)?, "bks", "Mes comptes", Some(existing))
            .map_err(wa)?;
        Ok((put(&self.registrations, state), options))
    }

    /// Enregistre la passkey et ouvre directement une session sur l'appareil. Renvoie le jeton de session.
    pub fn finish_registration(
        &self,
        conn: &Connection,
        id: &str,
        token: &str,
        name: &str,
        credential: &RegisterPublicKeyCredential,
        client: &Client,
    ) -> Result<String> {
        let state = take(&self.registrations, id).context("demande expirée, recommence")?;
        let passkey = self.webauthn.finish_passkey_registration(credential, &state).map_err(wa)?;
        // Le jeton n'est consommé qu'une fois la passkey validée.
        if !self.consume_enroll(token) {
            bail!("lien d'ajout invalide ou expiré");
        }
        let cred_id = serde_json::to_value(passkey.cred_id())?.as_str().unwrap_or_default().to_string();
        let name: String = name.trim().chars().take(60).collect();
        conn.execute(
            "INSERT INTO passkeys (name, credential_id, passkey, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![if name.is_empty() { "Appareil" } else { &name }, cred_id, serde_json::to_string(&passkey)?, db::now()],
        )?;
        create_session(conn, conn.last_insert_rowid(), client)
    }

    // ---------- Connexion ----------

    pub fn start_login(&self, conn: &Connection) -> Result<(String, RequestChallengeResponse)> {
        let passkeys: Vec<Passkey> = load_passkeys(conn)?.into_iter().map(|(_, pk)| pk).collect();
        if passkeys.is_empty() {
            bail!("aucune passkey enregistrée : ajoute un appareil depuis l'ordinateur");
        }
        let (options, state) = self.webauthn.start_passkey_authentication(&passkeys).map_err(wa)?;
        Ok((put(&self.logins, state), options))
    }

    pub fn finish_login(&self, conn: &Connection, id: &str, credential: &PublicKeyCredential, client: &Client) -> Result<String> {
        let state = take(&self.logins, id).context("demande expirée, recommence")?;
        let result = self.webauthn.finish_passkey_authentication(credential, &state).map_err(wa)?;
        let (pk_id, mut passkey) = load_passkeys(conn)?
            .into_iter()
            .find(|(_, pk)| pk.cred_id() == result.cred_id())
            .context("passkey inconnue")?;
        // Compteur de signatures et indicateurs de sauvegarde mis à jour.
        passkey.update_credential(&result);
        conn.execute(
            "UPDATE passkeys SET passkey = ?1, last_used_at = ?2 WHERE id = ?3",
            params![serde_json::to_string(&passkey)?, db::now(), pk_id],
        )?;
        create_session(conn, pk_id, client)
    }
}

/// Identifiant WebAuthn de l'unique utilisateur, créé au premier besoin.
fn user_id(conn: &Connection) -> Result<Uuid> {
    let existing: Option<String> =
        conn.query_row("SELECT value FROM app_settings WHERE key = 'webauthn_user_id'", [], |r| r.get(0)).optional()?;
    if let Some(v) = existing {
        return Ok(Uuid::parse_str(&v)?);
    }
    let id = Uuid::new_v4();
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('webauthn_user_id', ?1)", [id.to_string()])?;
    Ok(id)
}

fn load_passkeys(conn: &Connection) -> Result<Vec<(i64, Passkey)>> {
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, passkey FROM passkeys ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    rows.into_iter().map(|(id, json)| Ok((id, serde_json::from_str(&json)?))).collect()
}

pub fn passkey_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM passkeys", [], |r| r.get(0))?)
}

// ---------- Sessions ----------

/// Informations sur le client, pour la liste des appareils connectés.
pub struct Client {
    pub user_agent: Option<String>,
    pub ip: Option<String>,
}

fn expiry() -> String {
    (chrono::Utc::now() + chrono::Duration::days(SESSION_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn create_session(conn: &Connection, passkey_id: i64, client: &Client) -> Result<String> {
    let token = random_token();
    let now = db::now();
    conn.execute(
        "INSERT INTO auth_sessions (token_hash, passkey_id, user_agent, ip, created_at, last_seen_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![
            hash(&token),
            passkey_id,
            client.user_agent.as_deref().map(|u| u.chars().take(300).collect::<String>()),
            client.ip,
            now,
            expiry()
        ],
    )?;
    Ok(token)
}

pub enum SessionCheck {
    Invalid,
    Valid,
    /// Valide et prolongée : le cookie doit être renvoyé.
    Refreshed,
}

pub fn check_session(conn: &Connection, token: &str) -> Result<SessionCheck> {
    let h = hash(token);
    let row: Option<(String, String)> = conn
        .query_row("SELECT expires_at, last_seen_at FROM auth_sessions WHERE token_hash = ?1", [&h], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((expires, last_seen)) = row else { return Ok(SessionCheck::Invalid) };
    let now = db::now();
    if expires <= now {
        conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?1", [&h])?;
        return Ok(SessionCheck::Invalid);
    }
    // Prolongation au plus une fois par heure.
    let stale = chrono::DateTime::parse_from_rfc3339(&last_seen)
        .map(|t| chrono::Utc::now().signed_duration_since(t) > chrono::Duration::hours(1))
        .unwrap_or(true);
    if stale {
        conn.execute(
            "UPDATE auth_sessions SET last_seen_at = ?1, expires_at = ?2 WHERE token_hash = ?3",
            params![now, expiry(), h],
        )?;
        return Ok(SessionCheck::Refreshed);
    }
    Ok(SessionCheck::Valid)
}

pub fn delete_session(conn: &Connection, token: &str) -> Result<()> {
    conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?1", [hash(token)])?;
    Ok(())
}

pub fn set_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={}", SESSION_DAYS * 86_400)
}

pub fn clear_cookie() -> String {
    format!("{COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0")
}

/// Valeur du cookie de session dans un en-tête `Cookie`.
pub fn cookie_value(header: &str) -> Option<&str> {
    header
        .split(';')
        .map(str::trim)
        .find_map(|kv| kv.strip_prefix(COOKIE).and_then(|rest| rest.strip_prefix('=')))
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
}

// ---------- Appareils (interface locale) ----------

#[derive(Serialize)]
pub struct PasskeyInfo {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub id: i64,
    pub passkey_name: Option<String>,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    pub created_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
}

pub fn devices(conn: &Connection) -> Result<(Vec<PasskeyInfo>, Vec<SessionInfo>)> {
    let passkeys = conn
        .prepare("SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY id")?
        .query_map([], |r| Ok(PasskeyInfo { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, last_used_at: r.get(3)? }))?
        .collect::<Result<_, _>>()?;
    let sessions = conn
        .prepare(
            "SELECT s.id, p.name, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at
             FROM auth_sessions s LEFT JOIN passkeys p ON p.id = s.passkey_id
             WHERE s.expires_at > ?1 ORDER BY s.last_seen_at DESC",
        )?
        .query_map([db::now()], |r| {
            Ok(SessionInfo {
                id: r.get(0)?,
                passkey_name: r.get(1)?,
                user_agent: r.get(2)?,
                ip: r.get(3)?,
                created_at: r.get(4)?,
                last_seen_at: r.get(5)?,
                expires_at: r.get(6)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok((passkeys, sessions))
}

/// QR code (SVG noir sur blanc) d'un lien d'enrôlement.
pub fn qr_svg(url: &str) -> Result<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(url.as_bytes())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(232, 232)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_parsing() {
        let t = random_token();
        assert_eq!(t.len(), 64);
        let header = format!("theme=dark; {COOKIE}={t}; autre=1");
        assert_eq!(cookie_value(&header), Some(t.as_str()));
        assert_eq!(cookie_value("__Host-bks=pas-un-jeton"), None);
        assert_eq!(cookie_value("x__Host-bks=abc"), None);
        assert_ne!(hash(&t), t);
    }

    #[test]
    fn rp_from_url() {
        assert!(Auth::new("https://bks.example.org").is_ok());
        assert!(Auth::new("pas une url").is_err());
    }
}
