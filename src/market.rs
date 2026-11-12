//! Bourse : cotations (cache local) et compte-titres.
//!
//! Sources : API FRED (Réserve fédérale de Saint-Louis, clé gratuite) pour les indices comme le S&P 500 ;
//! Alpha Vantage (clé gratuite, 25 requêtes/jour) pour les actions (ex. OVH.PAR). Seuls les
//! symboles sont envoyés à ces services. Les clôtures sont conservées en base : l'historique
//! s'allonge à chaque rafraîchissement, même si la source n'en renvoie qu'une partie.

use crate::{AppState, db};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// Fraîcheur visée : 4 rafraîchissements par jour et par valeur au plus (quota Alpha Vantage).
const REFRESH_HOURS: i64 = 6;

#[derive(Serialize, Clone)]
pub struct Watch {
    pub id: i64,
    pub provider: String,
    pub symbol: String,
    pub name: String,
    pub currency: String,
    pub fetched_at: Option<String>,
    pub last_error: Option<String>,
    pub last: Option<Point>,
    pub previous: Option<Point>,
    /// Variation sur un an, en fraction.
    pub change_1y: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct Point {
    pub day: String,
    pub close: f64,
}

pub fn watchlist(conn: &Connection) -> Result<Vec<Watch>> {
    let rows: Vec<Watch> = conn
        .prepare("SELECT id, provider, symbol, name, currency, fetched_at, last_error FROM market_watch ORDER BY position, id")?
        .query_map([], |r| {
            Ok(Watch {
                id: r.get(0)?,
                provider: r.get(1)?,
                symbol: r.get(2)?,
                name: r.get(3)?,
                currency: r.get(4)?,
                fetched_at: r.get(5)?,
                last_error: r.get(6)?,
                last: None,
                previous: None,
                change_1y: None,
            })
        })?
        .collect::<Result<_, _>>()?;
    rows.into_iter()
        .map(|mut w| {
            let mut last2 = conn
                .prepare("SELECT day, close FROM market_prices WHERE watch_id = ?1 ORDER BY day DESC LIMIT 2")?
                .query_map([w.id], |r| Ok(Point { day: r.get(0)?, close: r.get(1)? }))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter();
            w.last = last2.next();
            w.previous = last2.next();
            if let Some(l) = &w.last {
                let year_ago: Option<f64> = conn
                    .query_row(
                        "SELECT close FROM market_prices WHERE watch_id = ?1 AND day <= date(?2, '-1 year') ORDER BY day DESC LIMIT 1",
                        params![w.id, l.day],
                        |r| r.get(0),
                    )
                    .ok();
                w.change_1y = year_ago.filter(|y| *y > 0.0).map(|y| l.close / y - 1.0);
            }
            Ok(w)
        })
        .collect()
}

pub fn history(conn: &Connection, watch_id: i64, since: Option<&str>) -> Result<Vec<Point>> {
    Ok(conn
        .prepare("SELECT day, close FROM market_prices WHERE watch_id = ?1 AND day >= COALESCE(?2, '0000') ORDER BY day")?
        .query_map(params![watch_id, since], |r| Ok(Point { day: r.get(0)?, close: r.get(1)? }))?
        .collect::<Result<_, _>>()?)
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("bks/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(60))
        .build()?)
}

async fn fetch_fred(series: &str, key: &str) -> Result<Vec<(String, f64)>> {
    let v: Value = http()?
        .get("https://api.stlouisfed.org/fred/series/observations")
        .query(&[("series_id", series), ("api_key", key), ("file_type", "json")])
        .send()
        .await?
        .json()
        .await?;
    if let Some(msg) = v.get("error_message").and_then(Value::as_str) {
        bail!("FRED : {msg}");
    }
    let out: Vec<(String, f64)> = v["observations"]
        .as_array()
        .context("FRED : réponse sans observations")?
        .iter()
        // Jours fériés : valeur « . ».
        .filter_map(|o| Some((o["date"].as_str()?.to_string(), o["value"].as_str()?.parse::<f64>().ok()?)))
        .collect();
    if out.is_empty() {
        bail!("série FRED « {series} » vide ou inconnue");
    }
    Ok(out)
}

async fn fetch_alphavantage(symbol: &str, key: &str) -> Result<Vec<(String, f64)>> {
    let v: Value = http()?
        .get("https://www.alphavantage.co/query")
        .query(&[("function", "TIME_SERIES_DAILY"), ("symbol", symbol), ("apikey", key)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if let Some(msg) = v.get("Error Message").or(v.get("Information")).or(v.get("Note")).and_then(Value::as_str) {
        bail!("Alpha Vantage : {msg}");
    }
    let series = v.get("Time Series (Daily)").and_then(Value::as_object).context("Alpha Vantage : réponse sans série")?;
    Ok(series
        .iter()
        .filter_map(|(day, o)| o.get("4. close")?.as_str()?.parse::<f64>().ok().map(|c| (day.clone(), c)))
        .collect())
}

/// Rafraîchit une valeur (sans tenir compte de la fraîcheur).
pub async fn refresh_one(state: &AppState, id: i64) -> Result<usize> {
    let (provider, symbol): (String, String) = state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT provider, symbol FROM market_watch WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let fetched = match provider.as_str() {
        "fred" => match state.cfg.market.fred_key.as_deref().filter(|k| !k.trim().is_empty()) {
            Some(key) => fetch_fred(&symbol, key.trim()).await,
            None => Err(anyhow::anyhow!("clé FRED manquante ([market] fred_key)")),
        },
        _ => match state.cfg.market.alphavantage_key.as_deref().filter(|k| !k.trim().is_empty()) {
            Some(key) => fetch_alphavantage(&symbol, key.trim()).await,
            None => Err(anyhow::anyhow!("clé Alpha Vantage manquante ([market] alphavantage_key)")),
        },
    };
    let conn = state.db.lock().unwrap();
    match fetched {
        Ok(points) => {
            let mut stmt = conn.prepare("INSERT OR REPLACE INTO market_prices (watch_id, day, close) VALUES (?1, ?2, ?3)")?;
            for (day, close) in &points {
                stmt.execute(params![id, day, close])?;
            }
            conn.execute("UPDATE market_watch SET fetched_at = ?1, last_error = NULL WHERE id = ?2", params![db::now(), id])?;
            Ok(points.len())
        }
        Err(e) => {
            conn.execute("UPDATE market_watch SET fetched_at = ?1, last_error = ?2 WHERE id = ?3", params![db::now(), format!("{e:#}"), id])?;
            Err(e)
        }
    }
}

/// Toutes les 30 min : rafraîchit les valeurs dont la dernière tentative date de plus de 6 h.
pub fn schedule(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1800));
        loop {
            tick.tick().await;
            let stale: Vec<i64> = {
                let conn = state.db.lock().unwrap();
                let ids = conn
                    .prepare(&format!(
                        "SELECT id FROM market_watch WHERE fetched_at IS NULL
                         OR fetched_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-{REFRESH_HOURS} hours')
                         OR (last_error IS NOT NULL AND fetched_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-25 minutes'))"
                    ))
                    .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect::<Result<Vec<i64>, _>>());
                ids.unwrap_or_default()
            };
            for id in stale {
                if let Err(e) = refresh_one(&state, id).await {
                    tracing::warn!(id, "cotation non rafraîchie : {e:#}");
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Compte-titres
// ---------------------------------------------------------------------------

pub const DEFAULT_PATTERNS: &str = "INVESTMENT ACCOUNT|ROBO";

#[derive(Serialize)]
pub struct Portfolio {
    /// Motifs de libellé des virements vers / depuis le compte-titres, séparés par « | ».
    pub patterns: String,
    pub deposits_cents: i64,
    pub withdrawals_cents: i64,
    pub net_invested_cents: i64,
    /// Mois → versé net cumulé.
    pub monthly: Vec<PortfolioMonth>,
    pub valuations: Vec<Valuation>,
    pub latest: Option<Valuation>,
    /// Plus-value : dernière valeur − net investi à cette date.
    pub gain_cents: Option<i64>,
}

#[derive(Serialize)]
pub struct PortfolioMonth {
    pub month: String,
    pub deposits_cents: i64,
    pub withdrawals_cents: i64,
    pub cumulative_net_cents: i64,
}

#[derive(Serialize, Clone)]
pub struct Valuation {
    pub day: String,
    pub value_cents: i64,
}

pub fn patterns(conn: &Connection) -> Result<String> {
    Ok(conn
        .query_row("SELECT value FROM app_settings WHERE key = 'portfolio_patterns'", [], |r| r.get(0))
        .unwrap_or_else(|_| DEFAULT_PATTERNS.to_string()))
}

pub fn portfolio(conn: &Connection) -> Result<Portfolio> {
    let pats = patterns(conn)?;
    let list: Vec<String> = pats.split('|').map(|p| p.trim().to_uppercase()).filter(|p| !p.is_empty()).collect();
    let rows: Vec<(String, i64, String)> = conn
        .prepare("SELECT day, amount_cents, upper(label || ' ' || COALESCE(counterparty, '')) FROM transactions WHERE day IS NOT NULL ORDER BY day")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut monthly: Vec<PortfolioMonth> = Vec::new();
    let (mut dep, mut wd, mut cum) = (0i64, 0i64, 0i64);
    let mut net_by_day: Vec<(String, i64)> = Vec::new();
    for (day, amount, _) in rows.iter().filter(|(_, _, t)| list.iter().any(|p| t.contains(p))) {
        let month = day[..7].to_string();
        if monthly.last().is_none_or(|m| m.month != month) {
            monthly.push(PortfolioMonth { month, deposits_cents: 0, withdrawals_cents: 0, cumulative_net_cents: cum });
        }
        let m = monthly.last_mut().unwrap();
        // Débit du compte courant = argent versé sur le compte-titres.
        if *amount < 0 {
            m.deposits_cents -= amount;
            dep -= amount;
        } else {
            m.withdrawals_cents += amount;
            wd += amount;
        }
        cum = dep - wd;
        m.cumulative_net_cents = cum;
        net_by_day.push((day.clone(), cum));
    }
    let valuations: Vec<Valuation> = conn
        .prepare("SELECT day, value_cents FROM portfolio_valuations ORDER BY day")?
        .query_map([], |r| Ok(Valuation { day: r.get(0)?, value_cents: r.get(1)? }))?
        .collect::<Result<_, _>>()?;
    let latest = valuations.last().cloned();
    let gain_cents = latest.as_ref().map(|v| {
        let invested = net_by_day.iter().rev().find(|(d, _)| d.as_str() <= v.day.as_str()).map_or(0, |(_, n)| *n);
        v.value_cents - invested
    });
    Ok(Portfolio { patterns: pats, deposits_cents: dep, withdrawals_cents: wd, net_invested_cents: dep - wd, monthly, valuations, latest, gain_cents })
}
