//! Interface privée (127.0.0.1, jamais derrière le tunnel) : API JSON + frontend compilé.

use super::{api, auth_api};
use crate::AppState;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};

pub fn router(state: Arc<AppState>) -> Router {
    let port = state.cfg.server.local_addr.port();
    let allowed: Arc<Vec<String>> =
        Arc::new(["localhost", "127.0.0.1", "[::1]"].iter().map(|h| format!("{h}:{port}")).collect());
    let api = api::router().merge(auth_api::local_router()).fallback(api::api_not_found);
    let app = with_spa(Router::new().nest("/api", api), &state);
    app.layer(middleware::from_fn_with_state(allowed, guard))
        .layer(middleware::from_fn(auth_api::security_headers))
        .with_state(state)
}

/// Frontend compilé en application monopage : toute route inconnue renvoie index.html.
pub fn with_spa(app: Router<Arc<AppState>>, state: &AppState) -> Router<Arc<AppState>> {
    let web_dir = state.cfg.server.web_dir.clone();
    let index = web_dir.join("index.html");
    if index.exists() {
        app.fallback_service(ServeDir::new(&web_dir).fallback(ServeFile::new(&index)))
    } else {
        tracing::warn!("{} introuvable : lance `pnpm build` dans web/", index.display());
        app.fallback(missing_frontend)
    }
}

async fn missing_frontend() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Html("<!doctype html><meta charset=utf-8><title>bks</title><p style=\"font:16px system-ui;padding:2rem\">\
              Frontend non compilé : <code>cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</code>, puis relance le serveur.</p>"),
    )
}

/// Protège contre le DNS rebinding (Host inattendu) et les requêtes d'autres sites (Origin).
async fn guard(State(allowed): State<Arc<Vec<String>>>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !allowed.iter().any(|a| a.eq_ignore_ascii_case(host)) {
        return (StatusCode::FORBIDDEN, "Host non autorisé").into_response();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
            if !allowed.iter().any(|a| origin.eq_ignore_ascii_case(&format!("http://{a}"))) {
                return (StatusCode::FORBIDDEN, "Origin non autorisée").into_response();
            }
        }
    }
    next.run(req).await
}
