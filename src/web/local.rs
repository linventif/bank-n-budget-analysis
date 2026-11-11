//! Tableau de bord, accessible uniquement depuis la machine (127.0.0.1, jamais via le tunnel).

use super::html::{esc, mask_iban, money, page_with_head};
use super::{AppError, HandlerResult};
use crate::eb::{Access, AspspRef, StartAuth};
use crate::{AppState, db, eb, sync};
use anyhow::anyhow;
use axum::Router;
use axum::extract::{Form, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const ASPSP_CACHE_TTL: Duration = Duration::from_secs(24 * 3600);

pub fn router(state: Arc<AppState>) -> Router {
    let port = state.cfg.server.local_addr.port();
    let allowed: Arc<Vec<String>> =
        Arc::new(["localhost", "127.0.0.1", "[::1]"].iter().map(|h| format!("{h}:{port}")).collect());
    Router::new()
        .route("/", get(dashboard))
        .route("/connect", post(connect))
        .route("/sync", post(sync_now))
        .layer(middleware::from_fn_with_state(allowed, guard))
        .with_state(state)
}

/// Protège contre le DNS rebinding (Host inattendu) et les POST venant d'autres sites (Origin).
async fn guard(State(allowed): State<Arc<Vec<String>>>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !allowed.iter().any(|a| a.eq_ignore_ascii_case(host)) {
        return (StatusCode::FORBIDDEN, "Host non autorisé").into_response();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let origin = req.headers().get(header::ORIGIN).and_then(|h| h.to_str().ok());
        if let Some(origin) = origin {
            if !allowed.iter().any(|a| origin.eq_ignore_ascii_case(&format!("http://{a}"))) {
                return (StatusCode::FORBIDDEN, "Origin non autorisée").into_response();
            }
        }
    }
    next.run(req).await
}

async fn aspsps(app: &AppState) -> anyhow::Result<Vec<eb::Aspsp>> {
    let (Some(client), Some(cfg)) = (app.eb.as_ref(), app.cfg.enable_banking.as_ref()) else {
        return Err(anyhow!("Enable Banking n'est pas configuré"));
    };
    let mut cache = app.aspsp_cache.lock().await;
    if let Some((at, list)) = cache.as_ref() {
        if at.elapsed() < ASPSP_CACHE_TTL {
            return Ok(list.clone());
        }
    }
    let mut list = Vec::new();
    for country in &cfg.countries {
        let mut part = client.aspsps(country).await?;
        part.sort_by_key(|a| a.name.to_lowercase());
        list.extend(part);
    }
    *cache = Some((Instant::now(), list.clone()));
    Ok(list)
}

async fn dashboard(State(app): State<Arc<AppState>>) -> HandlerResult<Html<String>> {
    let (accounts, txs) = {
        let conn = app.db.lock().unwrap();
        (db::list_accounts(&conn)?, db::recent_transactions(&conn, 200)?)
    };
    let syncing = app.syncing.load(Ordering::SeqCst);
    let now = db::now();
    let mut b = String::from("<h1>Mes comptes</h1>");

    if syncing {
        b += "<div class=\"notice\">Synchronisation en cours…</div>";
    } else if let Some(msg) = app.last_sync_message.lock().unwrap().as_deref() {
        b += &format!("<div class=\"notice\">{}</div>", esc(msg));
    }

    // --- Comptes ---
    if accounts.is_empty() {
        b += "<p class=\"muted\">Aucun compte pour l'instant. Connecte ta banque ci-dessous.</p>";
    } else {
        b += "<div class=\"accounts\">";
        for a in &accounts {
            let title = a.name.as_deref().or(a.product.as_deref()).unwrap_or("Compte");
            let balance = a
                .balance_cents
                .map(|c| money(c, &a.currency))
                .unwrap_or_else(|| "<span class=\"muted\">—</span>".into());
            let balance = match &a.balance_date {
                Some(d) => format!("{balance} <span class=\"muted\" style=\"font-size:.8rem\">au {}</span>", esc(d)),
                None => balance,
            };
            let expired = a.session_status.as_deref() != Some("AUTHORIZED")
                || a.valid_until.as_deref().is_none_or(|v| v <= now.as_str());
            let access = match (&a.valid_until, expired) {
                (_, true) => "<span class=\"warn\">Accès expiré : reconnecte la banque</span>".to_string(),
                (Some(v), false) => format!("Accès valable jusqu'au {}", esc(v.get(..10).unwrap_or(v))),
                (None, false) => String::new(),
            };
            b += &format!(
                "<div class=\"card\"><div class=\"muted\">{} · {}</div><strong>{}</strong>\
                 <div class=\"balance\">{balance}</div>\
                 <div class=\"muted\">{} opération(s) · synchro : {}</div><div class=\"muted\">{access}</div>{}</div>",
                esc(&a.aspsp_name),
                a.iban.as_deref().map(mask_iban).unwrap_or_default(),
                esc(title),
                a.tx_count,
                a.last_sync.as_deref().map(|s| esc(&s.replace('T', " ").replace('Z', " UTC"))).unwrap_or_else(|| "jamais".into()),
                a.last_error.as_deref().map(|e| format!("<div class=\"error\">{}</div>", esc(e))).unwrap_or_default(),
            );
        }
        b += "</div>";
        b += &format!(
            "<p><form class=\"inline\" method=\"post\" action=\"/sync\"><button{}>Synchroniser</button>\
             <span class=\"muted\">Les banques limitent souvent à ~4 synchros automatiques par jour.</span></form></p>",
            if syncing { " disabled" } else { "" }
        );
    }

    // --- Connexion d'une banque ---
    b += "<h2>Connecter une banque</h2>";
    match aspsps(&app).await {
        Ok(list) => {
            b += "<form class=\"inline\" method=\"post\" action=\"/connect\"><select name=\"aspsp\" required>\
                  <option value=\"\">Choisir…</option>";
            let mut current_country: Option<&str> = None;
            for a in &list {
                if current_country != Some(a.country.as_str()) {
                    if current_country.is_some() {
                        b += "</optgroup>";
                    }
                    b += &format!("<optgroup label=\"{}\">", esc(&a.country));
                    current_country = Some(&a.country);
                }
                let beta = if a.beta { " (bêta)" } else { "" };
                b += &format!(
                    "<option value=\"{}\">{} ({}){beta}</option>",
                    esc(&format!("{}|{}", a.name, a.country)),
                    esc(&a.name),
                    esc(&a.country)
                );
            }
            if current_country.is_some() {
                b += "</optgroup>";
            }
            b += "</select><button>Autoriser l'accès</button></form>\
                  <p class=\"muted\">Tu seras redirigé vers ta banque, puis vers le tunnel public (/callback).</p>";
        }
        Err(e) => b += &format!("<p class=\"error\">{}</p>", esc(&format!("{e:#}"))),
    }

    // --- Opérations ---
    if !txs.is_empty() {
        b += "<h2>Dernières opérations</h2><div class=\"scroll\"><table><thead><tr>\
              <th>Date</th><th>Libellé</th><th>Compte</th><th style=\"text-align:right\">Montant</th></tr></thead><tbody>";
        for t in &txs {
            let cls = if t.amount_cents < 0 { "neg" } else { "pos" };
            let pending = if t.status == "BOOK" { "" } else { " <span class=\"muted\">(en attente)</span>" };
            let party = match &t.counterparty {
                Some(p) if !t.label.contains(p.as_str()) => format!("<div class=\"muted\">{}</div>", esc(p)),
                _ => String::new(),
            };
            b += &format!(
                "<tr><td>{}</td><td>{}{pending}{party}</td><td class=\"muted\">{}</td><td class=\"amount {cls}\">{}</td></tr>",
                esc(t.date.as_deref().unwrap_or("")),
                esc(&t.label),
                esc(&t.account),
                money(t.amount_cents, &t.currency),
            );
        }
        b += "</tbody></table></div>";
    }

    let head = if syncing { "<meta http-equiv=\"refresh\" content=\"3\">" } else { "" };
    Ok(page_with_head("Mes comptes", head, &b))
}

#[derive(Deserialize)]
struct ConnectForm {
    aspsp: String,
}

async fn connect(State(app): State<Arc<AppState>>, Form(f): Form<ConnectForm>) -> HandlerResult<Redirect> {
    let (Some(client), Some(cfg)) = (app.eb.as_ref(), app.cfg.enable_banking.as_ref()) else {
        return Err(AppError::from(anyhow!("Enable Banking n'est pas configuré")));
    };
    let (name, country) = f.aspsp.rsplit_once('|').ok_or_else(|| anyhow!("choix de banque invalide"))?;
    let list = aspsps(&app).await?;
    let aspsp = list
        .iter()
        .find(|a| a.name == name && a.country == country)
        .ok_or_else(|| anyhow!("banque inconnue : {name} ({country})"))?;

    // Durée demandée, plafonnée par la banque (avec une marge d'une minute).
    let wanted = cfg.consent_days * 86_400;
    let secs = aspsp.maximum_consent_validity.map_or(wanted, |max| wanted.min(max - 60)).max(3600);
    let valid_until = (chrono::Utc::now() + chrono::Duration::seconds(secs))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let state = uuid::Uuid::new_v4().to_string();
    db::insert_pending(&app.db.lock().unwrap(), &state, &aspsp.name, &aspsp.country)?;

    let redirect_url = app.cfg.redirect_url();
    let resp = client
        .start_auth(&StartAuth {
            access: Access { valid_until },
            aspsp: AspspRef { name: aspsp.name.clone(), country: aspsp.country.clone() },
            state: &state,
            redirect_url: &redirect_url,
            psu_type: "personal",
            language: "fr",
        })
        .await?;
    Ok(Redirect::to(&resp.url))
}

async fn sync_now(State(app): State<Arc<AppState>>) -> Redirect {
    sync::spawn(app);
    Redirect::to("/")
}
