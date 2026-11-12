//! Routes d'authentification et protections de l'accès distant.

use super::api::{ApiError, ApiResult};
use crate::AppState;
use crate::auth::{self, Client, SessionCheck};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};

// ---------------------------------------------------------------------------
// Public (via le tunnel)
// ---------------------------------------------------------------------------

pub fn public_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/me", get(me_public))
        .route("/login/start", post(login_start))
        .route("/login/finish", post(login_finish))
        .route("/register/start", post(register_start))
        .route("/register/finish", post(register_finish))
        .route("/logout", post(logout))
}

fn client(headers: &HeaderMap) -> Client {
    let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    Client { user_agent: h("user-agent"), ip: h("cf-connecting-ip") }
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(auth::cookie_value)
        .map(str::to_string)
}

fn with_cookie(body: Value, cookie: String) -> Response {
    let mut res = Json(body).into_response();
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        res.headers_mut().append(header::SET_COOKIE, v);
    }
    res
}

/// Les messages d'échec restent génériques côté public (aucun détail exploitable).
fn denied(e: anyhow::Error) -> ApiError {
    tracing::warn!("authentification refusée : {e:#}");
    let msg = format!("{e:#}");
    if msg.contains("expiré") || msg.contains("aucune passkey") || msg.contains("lien d'ajout") {
        ApiError::bad(msg)
    } else {
        ApiError::bad("vérification de la passkey impossible")
    }
}

async fn me_public(State(app): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult<Value> {
    let conn = app.db.lock().unwrap();
    let authenticated = match session_token(&headers) {
        Some(t) => !matches!(auth::check_session(&conn, &t)?, SessionCheck::Invalid),
        None => false,
    };
    Ok(Json(json!({
        "authenticated": authenticated,
        "local": false,
        "has_passkeys": auth::passkey_count(&conn)? > 0,
        "public_url": app.cfg.server.public_url,
    })))
}

async fn login_start(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let (id, options) = app.auth.start_login(&app.db.lock().unwrap()).map_err(denied)?;
    Ok(Json(json!({ "id": id, "options": options })))
}

#[derive(Deserialize)]
struct LoginFinish {
    id: String,
    credential: PublicKeyCredential,
}

async fn login_finish(State(app): State<Arc<AppState>>, headers: HeaderMap, Json(b): Json<LoginFinish>) -> Result<Response, ApiError> {
    let token = app.auth.finish_login(&app.db.lock().unwrap(), &b.id, &b.credential, &client(&headers)).map_err(denied)?;
    tracing::info!("connexion par passkey");
    Ok(with_cookie(json!({ "ok": true }), auth::set_cookie(&token)))
}

#[derive(Deserialize)]
struct RegisterStart {
    token: String,
}

async fn register_start(State(app): State<Arc<AppState>>, Json(b): Json<RegisterStart>) -> ApiResult<Value> {
    let (id, options) = app.auth.start_registration(&app.db.lock().unwrap(), &b.token).map_err(denied)?;
    Ok(Json(json!({ "id": id, "options": options })))
}

#[derive(Deserialize)]
struct RegisterFinish {
    id: String,
    token: String,
    #[serde(default)]
    name: String,
    credential: RegisterPublicKeyCredential,
}

async fn register_finish(State(app): State<Arc<AppState>>, headers: HeaderMap, Json(b): Json<RegisterFinish>) -> Result<Response, ApiError> {
    let token = app
        .auth
        .finish_registration(&app.db.lock().unwrap(), &b.id, &b.token, &b.name, &b.credential, &client(&headers))
        .map_err(denied)?;
    tracing::info!(appareil = b.name, "nouvelle passkey enregistrée");
    Ok(with_cookie(json!({ "ok": true }), auth::set_cookie(&token)))
}

async fn logout(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Result<Response, ApiError> {
    if let Some(t) = session_token(&headers) {
        auth::delete_session(&app.db.lock().unwrap(), &t)?;
    }
    Ok(with_cookie(json!({ "ok": true }), auth::clear_cookie()))
}

/// Toutes les données (/api hors /api/auth) exigent une session valide côté public.
pub async fn require_session(State(app): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let token = session_token(req.headers());
    let check = match token.as_deref() {
        Some(t) => match auth::check_session(&app.db.lock().unwrap(), t) {
            Ok(c) => c,
            Err(e) => return ApiError::from(e).into_response(),
        },
        None => SessionCheck::Invalid,
    };
    match check {
        SessionCheck::Invalid => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "connexion requise" }))).into_response(),
        SessionCheck::Valid => next.run(req).await,
        SessionCheck::Refreshed => {
            // Session prolongée : le cookie est renvoyé avec une nouvelle durée de vie.
            let cookie = auth::set_cookie(token.as_deref().unwrap_or_default());
            let mut res = next.run(req).await;
            if let Ok(v) = HeaderValue::from_str(&cookie) {
                res.headers_mut().append(header::SET_COOKIE, v);
            }
            res
        }
    }
}

/// Côté public : hôte attendu uniquement, et Origin obligatoire et identique pour toute écriture.
pub async fn public_guard(State(app): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let public = &app.cfg.server.public_url;
    let expected_host = public.split_once("://").map_or(public.as_str(), |(_, h)| h);
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !host.eq_ignore_ascii_case(expected_host) {
        return (StatusCode::MISDIRECTED_REQUEST, "Hôte inattendu").into_response();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let origin = req.headers().get(header::ORIGIN).and_then(|h| h.to_str().ok()).unwrap_or("");
        if !origin.eq_ignore_ascii_case(public) {
            return (StatusCode::FORBIDDEN, "Origine non autorisée").into_response();
        }
    }
    next.run(req).await
}

/// En-têtes de sécurité communs (et pas de cache pour l'API).
pub async fn security_headers(req: Request, next: Next) -> Response {
    let is_api = req.uri().path().starts_with("/api/");
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    let set = |h: &mut HeaderMap, k: &'static str, v: &'static str| {
        h.entry(k).or_insert(HeaderValue::from_static(v));
    };
    set(
        h,
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
         connect-src 'self' https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com; \
         font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    set(h, "x-content-type-options", "nosniff");
    set(h, "x-frame-options", "DENY");
    set(h, "referrer-policy", "no-referrer");
    set(h, "cross-origin-opener-policy", "same-origin");
    set(h, "permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    set(h, "x-robots-tag", "noindex, nofollow");
    if is_api {
        set(h, "cache-control", "no-store");
    }
    res
}

/// HSTS uniquement côté public (servi en HTTPS par Cloudflare).
pub async fn hsts(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    res.headers_mut()
        .entry("strict-transport-security")
        .or_insert(HeaderValue::from_static("max-age=31536000"));
    res
}

// ---------------------------------------------------------------------------
// Local (127.0.0.1 uniquement) : pas d'authentification, gestion des appareils
// ---------------------------------------------------------------------------

pub fn local_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/auth/me", get(me_local))
        .route("/devices", get(devices))
        .route("/devices/enroll", post(enroll_link))
        .route("/devices/passkeys/{id}", patch(rename_passkey).delete(delete_passkey))
        .route("/devices/sessions/{id}", axum::routing::delete(revoke_session))
}

async fn me_local(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    Ok(Json(json!({
        "authenticated": true,
        "local": true,
        "has_passkeys": auth::passkey_count(&app.db.lock().unwrap())? > 0,
        "public_url": app.cfg.server.public_url,
        "public_dashboard": app.cfg.server.public_dashboard,
    })))
}

async fn devices(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let (passkeys, sessions) = auth::devices(&app.db.lock().unwrap())?;
    Ok(Json(json!({ "passkeys": passkeys, "sessions": sessions })))
}

async fn enroll_link(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    if !app.cfg.server.public_dashboard {
        return Err(ApiError::bad("tableau de bord public désactivé (server.public_dashboard = false)"));
    }
    let token = app.auth.new_enroll_token();
    // Jeton dans le fragment : jamais envoyé au serveur ni journalisé par le tunnel.
    let url = format!("{}/enroll#t={token}", app.cfg.server.public_url);
    let expires_at = (chrono::Utc::now() + chrono::Duration::from_std(auth::ENROLL_TTL).unwrap_or_default())
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    Ok(Json(json!({ "url": url, "expires_at": expires_at, "qr_svg": auth::qr_svg(&url)? })))
}

#[derive(Deserialize)]
struct Rename {
    name: String,
}

async fn rename_passkey(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Json(b): Json<Rename>) -> ApiResult<Value> {
    let name: String = b.name.trim().chars().take(60).collect();
    if name.is_empty() {
        return Err(ApiError::bad("nom vide"));
    }
    if app.db.lock().unwrap().execute("UPDATE passkeys SET name = ?1 WHERE id = ?2", rusqlite::params![name, id])? == 0 {
        return Err(ApiError::not_found("passkey inconnue"));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete_passkey(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    // Les sessions ouvertes avec cette passkey sont supprimées en cascade.
    if app.db.lock().unwrap().execute("DELETE FROM passkeys WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::not_found("passkey inconnue"));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn revoke_session(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    if app.db.lock().unwrap().execute("DELETE FROM auth_sessions WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::not_found("session inconnue"));
    }
    Ok(Json(json!({ "ok": true })))
}
