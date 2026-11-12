//! API Bourse : valeurs suivies, historiques, compte-titres.

use super::api::{ApiError, ApiResult};
use crate::{AppState, market};
use axum::extract::{Path, Query, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/market", get(list).post(add))
        .route("/market/{id}", delete(remove))
        .route("/market/{id}/history", get(history))
        .route("/market/{id}/refresh", post(refresh))
        .route("/portfolio", get(portfolio).patch(set_patterns))
        .route("/portfolio/valuations", post(add_valuation))
        .route("/portfolio/valuations/{day}", delete(delete_valuation))
}

async fn list(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let items = market::watchlist(&app.db.lock().unwrap())?;
    let set = |k: &Option<String>| k.as_deref().is_some_and(|k| !k.trim().is_empty());
    Ok(Json(json!({
        "items": items,
        "alphavantage_key": set(&app.cfg.market.alphavantage_key),
        "fred_key": set(&app.cfg.market.fred_key),
    })))
}

#[derive(Deserialize)]
struct HistoryQuery {
    since: Option<String>,
}

async fn history(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Query(q): Query<HistoryQuery>) -> ApiResult<Vec<market::Point>> {
    Ok(Json(market::history(&app.db.lock().unwrap(), id, q.since.as_deref())?))
}

async fn refresh(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    let n = market::refresh_one(&app, id).await.map_err(|e| ApiError::bad(format!("{e:#}")))?;
    Ok(Json(json!({ "points": n })))
}

#[derive(Deserialize)]
struct AddInput {
    provider: String,
    symbol: String,
    name: String,
    #[serde(default)]
    currency: String,
}

async fn add(State(app): State<Arc<AppState>>, Json(b): Json<AddInput>) -> ApiResult<Value> {
    let symbol = b.symbol.trim().to_uppercase();
    let ok_symbol = !symbol.is_empty() && symbol.len() <= 20 && symbol.chars().all(|c| c.is_ascii_alphanumeric() || ".-^_".contains(c));
    if !ok_symbol || !["fred", "alphavantage"].contains(&b.provider.as_str()) || b.name.trim().is_empty() {
        return Err(ApiError::bad("symbole, source ou nom invalide"));
    }
    let id = {
        let conn = app.db.lock().unwrap();
        conn.execute(
            "INSERT INTO market_watch (provider, symbol, name, currency, position)
             VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position), 0) + 1 FROM market_watch))",
            params![b.provider, symbol, b.name.trim(), if b.currency.trim().is_empty() { "EUR" } else { b.currency.trim() }],
        )
        .map_err(|_| ApiError::bad("valeur déjà suivie"))?;
        conn.last_insert_rowid()
    };
    // Vérifie tout de suite que la source connaît le symbole.
    if let Err(e) = market::refresh_one(&app, id).await {
        app.db.lock().unwrap().execute("DELETE FROM market_watch WHERE id = ?1", [id])?;
        return Err(ApiError::bad(format!("{e:#}")));
    }
    Ok(Json(json!({ "id": id })))
}

async fn remove(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    if app.db.lock().unwrap().execute("DELETE FROM market_watch WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::not_found("valeur inconnue"));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn portfolio(State(app): State<Arc<AppState>>) -> ApiResult<market::Portfolio> {
    Ok(Json(market::portfolio(&app.db.lock().unwrap())?))
}

#[derive(Deserialize)]
struct Patterns {
    patterns: String,
}

async fn set_patterns(State(app): State<Arc<AppState>>, Json(b): Json<Patterns>) -> ApiResult<Value> {
    let p = b.patterns.trim();
    if p.is_empty() || p.len() > 200 {
        return Err(ApiError::bad("motifs invalides"));
    }
    app.db.lock().unwrap().execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('portfolio_patterns', ?1)",
        [p],
    )?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ValuationInput {
    day: Option<String>,
    value_cents: i64,
}

async fn add_valuation(State(app): State<Arc<AppState>>, Json(b): Json<ValuationInput>) -> ApiResult<Value> {
    let day = b.day.unwrap_or_else(|| chrono::Local::now().date_naive().to_string());
    if chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d").is_err() || b.value_cents < 0 || b.value_cents > 100_000_000_000 {
        return Err(ApiError::bad("date ou montant invalide"));
    }
    app.db.lock().unwrap().execute(
        "INSERT OR REPLACE INTO portfolio_valuations (day, value_cents) VALUES (?1, ?2)",
        params![day, b.value_cents],
    )?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_valuation(State(app): State<Arc<AppState>>, Path(day): Path<String>) -> ApiResult<Value> {
    app.db.lock().unwrap().execute("DELETE FROM portfolio_valuations WHERE day = ?1", [day])?;
    Ok(Json(json!({ "ok": true })))
}
