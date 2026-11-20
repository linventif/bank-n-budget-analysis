//! API JSON du tableau de bord (interface privée uniquement).

use crate::eb::{Access, AspspRef, StartAuth};
use crate::{AppState, categorize, db, merchant, suggest, sync};
use anyhow::anyhow;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::Datelike;
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/accounts", get(accounts))
        .route("/summary", get(summary))
        .route("/trends", get(trends))
        .route("/recurring", get(recurring))
        .route("/recurring/manual", post(add_manual_recurring))
        .route("/recurring/manual/{id}", delete(delete_manual_recurring))
        .route("/transactions", get(transactions))
        .route("/transactions/{id}", patch(update_transaction))
        .route("/categories", get(list_categories).post(create_category))
        .route("/categories/{id}", patch(update_category).delete(delete_category))
        .route("/rules", get(list_rules).post(create_rule))
        .route("/rules/batch", post(create_rules))
        .route("/rules/suggestions", get(rule_suggestions).delete(reset_suggestions))
        .route("/rules/suggestions/dismiss", post(dismiss_suggestion))
        .route("/rules/{id}", delete(delete_rule))
        .route("/sync", post(start_sync))
        .route("/classify", post(start_classify))
        .route("/classify/cancel", post(cancel_classify))
        .route("/banks", get(banks))
        .route("/connect", post(connect))
        .merge(super::budget_api::router())
        .merge(super::market_api::router())
}

/// Chemin d'API inconnu : 404 JSON (et pas la page de l'application).
pub async fn api_not_found() -> ApiError {
    ApiError::not_found("ressource inconnue")
}

// ---------- Erreurs ----------

pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(crate) fn bad(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: msg.into() }
    }
    pub(crate) fn not_found(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: msg.into() }
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        let e = e.into();
        tracing::error!("{e:#}");
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: format!("{e:#}") }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

pub(crate) type ApiResult<T> = Result<Json<T>, ApiError>;

// ---------- Mois ----------

type Ym = (i32, u32);

fn ym(s: &str) -> Option<Ym> {
    let (y, m) = s.get(..7)?.split_once('-')?;
    let (y, m) = (y.parse().ok()?, m.parse().ok()?);
    (1..=12).contains(&m).then_some((y, m))
}
fn fmt_ym((y, m): Ym) -> String {
    format!("{y:04}-{m:02}")
}
fn add_months((y, m): Ym, n: i32) -> Ym {
    let idx = y * 12 + m as i32 - 1 + n;
    (idx.div_euclid(12), idx.rem_euclid(12) as u32 + 1)
}
fn days_in(m: Ym) -> u32 {
    let (ny, nm) = add_months(m, 1);
    chrono::NaiveDate::from_ymd_opt(ny, nm, 1).and_then(|d| d.pred_opt()).map_or(30, |d| d.day())
}
fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

fn mask_iban(iban: &str) -> String {
    let c: Vec<char> = iban.chars().filter(|c| !c.is_whitespace()).collect();
    if c.len() <= 8 {
        return c.iter().collect();
    }
    format!("{} •••• {}", c[..4].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>())
}

// ---------- Statut ----------

async fn status(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let health = match app.ai.as_ref() {
        Some(ai) => Some(ai.health().await),
        None => None,
    };
    let conn = app.db.lock().unwrap();
    let (transactions, uncategorized, to_review): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE category_id IS NULL),
                COUNT(*) FILTER (WHERE category_source = 'ai' AND category_confidence < 0.6)
         FROM ledger",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    Ok(Json(json!({
        "syncing": app.syncing.load(Ordering::SeqCst),
        "last_sync_message": app.last_sync_message.lock().unwrap().clone(),
        "enable_banking": app.eb.is_some(),
        "ai": {
            "enabled": app.ai.is_some(),
            "health": health,
            "progress": app.ai_progress.lock().unwrap().clone(),
        },
        "counts": { "transactions": transactions, "uncategorized": uncategorized, "to_review": to_review },
    })))
}

// ---------- Comptes ----------

/// Dépenses en attente (≤ 0) à retrancher du solde du compte `a`.
/// Seuls les soldes comptabilisés (CLBD, ITBD, OPBD) les excluent : les soldes disponibles
/// (ITAV, CLAV) et prévisionnels (XPCD) les déduisent déjà côté banque.
const PENDING_SQL: &str = "CASE WHEN a.balance_type IN ('CLBD', 'ITBD', 'OPBD') THEN
        (SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t
         WHERE t.account_hash = a.hash AND t.status <> 'BOOK' AND t.amount_cents < 0 AND t.currency = a.currency)
    ELSE 0 END";

#[derive(Serialize)]
struct Account {
    id: String,
    bank: String,
    name: Option<String>,
    product: Option<String>,
    iban: Option<String>,
    currency: String,
    /// Solde renvoyé par la banque.
    balance_cents: Option<i64>,
    /// Dépenses en attente non comprises dans ce solde (≤ 0).
    pending_cents: i64,
    /// Solde après ces dépenses en attente.
    available_cents: Option<i64>,
    balance_date: Option<String>,
    last_sync: Option<String>,
    last_error: Option<String>,
    valid_until: Option<String>,
    expired: bool,
    tx_count: i64,
    closed_at: Option<String>,
    cash_account_type: Option<String>,
}

async fn accounts(State(app): State<Arc<AppState>>) -> ApiResult<Vec<Account>> {
    let conn = app.db.lock().unwrap();
    let now = db::now();
    let rows = conn
        .prepare(&format!(
            "SELECT a.hash, a.aspsp_name, a.name, a.product, a.iban, a.currency, a.balance_cents, a.balance_date,
                    a.last_sync, a.last_error, s.valid_until, s.status,
                    (SELECT COUNT(*) FROM transactions t WHERE t.account_hash = a.hash), a.closed_at, a.cash_account_type,
                    {PENDING_SQL}
             FROM accounts a LEFT JOIN sessions s ON s.session_id = a.session_id
             ORDER BY a.closed_at IS NOT NULL, a.aspsp_name, a.cash_account_type, a.name",
        ))?
        .query_map([], |r| {
            let valid_until: Option<String> = r.get(10)?;
            let status: Option<String> = r.get(11)?;
            let balance_cents: Option<i64> = r.get(6)?;
            let pending_cents: i64 = r.get(15)?;
            Ok(Account {
                id: r.get(0)?,
                bank: r.get(1)?,
                name: r.get(2)?,
                product: r.get(3)?,
                iban: r.get::<_, Option<String>>(4)?.map(|i| mask_iban(&i)),
                currency: r.get(5)?,
                balance_cents,
                pending_cents,
                available_cents: balance_cents.map(|b| b + pending_cents),
                balance_date: r.get(7)?,
                last_sync: r.get(8)?,
                last_error: r.get(9)?,
                expired: status.as_deref() != Some("AUTHORIZED")
                    || valid_until.as_deref().is_none_or(|v| v <= now.as_str()),
                valid_until,
                tx_count: r.get(12)?,
                closed_at: r.get(13)?,
                cash_account_type: r.get(14)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(rows))
}

// ---------- Résumé mensuel ----------

#[derive(Deserialize)]
struct MonthQuery {
    month: Option<String>,
}

#[derive(Serialize, Default, Clone, Copy)]
struct Totals {
    expenses_cents: i64,
    income_cents: i64,
}

#[derive(Serialize)]
struct MonthTotals {
    month: String,
    expenses_cents: i64,
    income_cents: i64,
}

#[derive(Serialize)]
struct CatAmount {
    category_id: Option<i64>,
    amount_cents: i64,
    count: i64,
    prev_cents: i64,
    avg_cents: i64,
    budget_cents: Option<i64>,
}

#[derive(Serialize)]
struct MerchantSpend {
    merchant: String,
    name: String,
    amount_cents: i64,
    count: i64,
    category_id: Option<i64>,
}

#[derive(Serialize, Default)]
struct Summary {
    month: Option<String>,
    months: Vec<String>,
    is_current_month: bool,
    /// Solde des comptes en euros, dépenses en attente déduites.
    balance_cents: i64,
    /// Dépenses en attente déjà retranchées de `balance_cents` (≤ 0).
    pending_cents: i64,
    totals: Totals,
    prev: Totals,
    avg: Totals,
    avg_months: usize,
    by_category: Vec<CatAmount>,
    income_by_category: Vec<CatAmount>,
    monthly: Vec<MonthTotals>,
    cumulative_current: Vec<i64>,
    cumulative_average: Vec<i64>,
    cumulative_previous: Vec<CumulativeMonth>,
    days_in_month: u32,
    top_merchants: Vec<MerchantSpend>,
}

#[derive(Serialize)]
struct CumulativeMonth {
    month: String,
    values: Vec<i64>,
}

fn months_available(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.prepare("SELECT DISTINCT month FROM ledger ORDER BY month")?
        .query_map([], |r| r.get(0))?
        .collect()
}

/// Premier mois complet de l'historique (le tout premier est souvent partiel).
fn first_full_month(conn: &Connection) -> rusqlite::Result<Option<Ym>> {
    let first: Option<String> = conn.query_row("SELECT MIN(day) FROM ledger", [], |r| r.get(0))?;
    Ok(first.and_then(|d| {
        let m = ym(&d)?;
        let dom: u32 = d.get(8..10)?.parse().ok()?;
        Some(if dom <= 3 { m } else { add_months(m, 1) })
    }))
}

async fn summary(State(app): State<Arc<AppState>>, Query(q): Query<MonthQuery>) -> ApiResult<Summary> {
    let conn = app.db.lock().unwrap();
    Ok(Json(summarize(&conn, q.month, today())?))
}

fn summarize(conn: &Connection, requested_month: Option<String>, t: chrono::NaiveDate) -> Result<Summary, ApiError> {
    let months = months_available(conn)?;
    let (balance_cents, pending_cents): (i64, i64) = conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(balance_cents + pending), 0), COALESCE(SUM(pending), 0)
             FROM (SELECT a.balance_cents, {PENDING_SQL} AS pending FROM accounts a
                   WHERE a.currency = 'EUR' AND a.closed_at IS NULL AND a.balance_cents IS NOT NULL)"
        ),
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let Some(last) = months.last().cloned() else {
        return Ok(Summary { balance_cents, pending_cents, ..Default::default() });
    };
    let month = requested_month.filter(|m| months.contains(m)).unwrap_or(last);
    let sel = ym(&month).ok_or_else(|| ApiError::bad("mois invalide"))?;
    let first = ym(&months[0]).unwrap_or(sel);
    let first_full = first_full_month(conn)?.unwrap_or(first);
    let current = (t.year(), t.month());

    // Mois de référence pour les moyennes : jusqu'à 6 mois complets avant le mois choisi.
    let refs: Vec<Ym> = (1..=6).map(|k| add_months(sel, -k)).filter(|m| *m >= first_full).collect();
    let lo = refs.last().copied().unwrap_or(sel).min(add_months(sel, -11)).max(first);

    let mut totals: HashMap<String, Totals> = HashMap::new();
    for row in conn
        .prepare(
            "SELECT month, COALESCE(-SUM(amount_cents) FILTER (WHERE kind = 'expense'), 0),
                    COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'income'), 0)
             FROM ledger GROUP BY month",
        )?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, Totals { expenses_cents: r.get(1)?, income_cents: r.get(2)? })))?
    {
        let (m, tot) = row?;
        totals.insert(m, tot);
    }
    let get = |m: Ym| totals.get(&fmt_ym(m)).copied().unwrap_or_default();
    let n = refs.len().max(1) as i64;
    let avg = Totals {
        expenses_cents: refs.iter().map(|m| get(*m).expenses_cents).sum::<i64>() / n,
        income_cents: refs.iter().map(|m| get(*m).income_cents).sum::<i64>() / n,
    };

    let monthly = (0..12)
        .rev()
        .map(|k| add_months(sel, -k))
        .filter(|m| *m >= first)
        .map(|m| MonthTotals { month: fmt_ym(m), expenses_cents: get(m).expenses_cents, income_cents: get(m).income_cents })
        .collect();

    // Par catégorie : mois choisi, mois précédent, moyenne des mois de référence.
    let by_kind = |kind: &str, sign: i64| -> Result<Vec<CatAmount>, ApiError> {
        let mut per: HashMap<Option<i64>, (i64, i64, HashMap<String, i64>)> = HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT category_id, month, SUM(amount_cents), COUNT(*) FROM ledger
             WHERE kind = ?1 AND month BETWEEN ?2 AND ?3 GROUP BY category_id, month",
        )?;
        let rows = stmt.query_map(params![kind, fmt_ym(lo), month], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
        })?;
        for row in rows {
            let (cat, m, sum, count) = row?;
            let e = per.entry(cat).or_default();
            if m == month {
                e.0 = sign * sum;
                e.1 = count;
            }
            e.2.insert(m, sign * sum);
        }
        let mut out: Vec<CatAmount> = per
            .into_iter()
            .map(|(cat, (amount, count, by_month))| CatAmount {
                category_id: cat,
                amount_cents: amount,
                count,
                prev_cents: by_month.get(&fmt_ym(add_months(sel, -1))).copied().unwrap_or(0),
                avg_cents: refs.iter().map(|m| by_month.get(&fmt_ym(*m)).copied().unwrap_or(0)).sum::<i64>() / n,
                budget_cents: None,
            })
            .collect();
        out.sort_by(|a, b| b.amount_cents.cmp(&a.amount_cents).then(b.avg_cents.cmp(&a.avg_cents)));
        Ok(out)
    };
    let mut by_category = by_kind("expense", -1)?;
    let income_by_category = by_kind("income", 1)?.into_iter().filter(|c| c.amount_cents != 0).collect();

    // Budgets (y compris les catégories budgétées sans dépense ce mois-ci).
    let budgets: HashMap<i64, i64> = conn
        .prepare("SELECT id, budget_cents FROM categories WHERE budget_cents IS NOT NULL AND kind = 'expense'")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for c in by_category.iter_mut() {
        c.budget_cents = c.category_id.and_then(|id| budgets.get(&id).copied());
    }
    for (id, b) in &budgets {
        if !by_category.iter().any(|c| c.category_id == Some(*id)) {
            by_category.push(CatAmount {
                category_id: Some(*id),
                amount_cents: 0,
                count: 0,
                prev_cents: 0,
                avg_cents: 0,
                budget_cents: Some(*b),
            });
        }
    }
    by_category.retain(|c| c.amount_cents != 0 || c.avg_cents != 0 || c.budget_cents.is_some());

    // Dépenses cumulées jour par jour : mois choisi vs moyenne des mois de référence.
    let mut daily: HashMap<String, Vec<i64>> = HashMap::new();
    for row in conn
        .prepare(
            "SELECT day, -SUM(amount_cents) FROM ledger
             WHERE kind = 'expense' AND month BETWEEN ?1 AND ?2 GROUP BY day",
        )?
        .query_map(params![fmt_ym(lo), month], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
    {
        let (day, v) = row?;
        let (Some(m), Some(d)) = (ym(&day), day.get(8..10).and_then(|d| d.parse::<usize>().ok())) else { continue };
        let arr = daily.entry(fmt_ym(m)).or_insert_with(|| vec![0; days_in(m) as usize]);
        if let Some(slot) = arr.get_mut(d.saturating_sub(1)) {
            *slot += v;
        }
    }
    let cumul = |m: Ym| -> Vec<i64> {
        let base = daily.get(&fmt_ym(m)).cloned().unwrap_or_else(|| vec![0; days_in(m) as usize]);
        base.iter()
            .scan(0i64, |acc, v| {
                *acc += v;
                Some(*acc)
            })
            .collect()
    };
    let dim = days_in(sel);
    let shown_days = if sel == current { t.day() } else { dim };
    let cumulative_current: Vec<i64> = cumul(sel).into_iter().take(shown_days as usize).collect();
    let cumulative_previous = (1..=2)
        .map(|offset| add_months(sel, -offset))
        .filter(|m| *m >= first)
        .map(|m| CumulativeMonth { month: fmt_ym(m), values: cumul(m) })
        .collect();
    let ref_curves: Vec<Vec<i64>> = refs.iter().map(|m| cumul(*m)).collect();
    let cumulative_average: Vec<i64> = if ref_curves.is_empty() {
        vec![]
    } else {
        (0..dim as usize)
            .map(|d| {
                ref_curves.iter().map(|c| c.get(d).or(c.last()).copied().unwrap_or(0)).sum::<i64>()
                    / ref_curves.len() as i64
            })
            .collect()
    };

    let top_merchants = conn
        .prepare(
            "SELECT merchant, -SUM(amount_cents), COUNT(*), category_id, MAX(day) FROM ledger
             WHERE kind = 'expense' AND month = ?1 AND merchant IS NOT NULL
             GROUP BY merchant HAVING -SUM(amount_cents) > 0 ORDER BY 2 DESC LIMIT 8",
        )?
        .query_map([&month], |r| {
            let m: String = r.get(0)?;
            Ok(MerchantSpend {
                name: merchant::display(&m),
                merchant: m,
                amount_cents: r.get(1)?,
                count: r.get(2)?,
                category_id: r.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;

    Ok(Summary {
        is_current_month: sel == current,
        month: Some(month),
        months,
        balance_cents,
        pending_cents,
        totals: get(sel),
        prev: get(add_months(sel, -1)),
        avg,
        avg_months: refs.len(),
        by_category,
        income_by_category,
        monthly,
        cumulative_current,
        cumulative_average,
        cumulative_previous,
        days_in_month: dim,
        top_merchants,
    })
}

// ---------- Tendances ----------

#[derive(Deserialize)]
struct TrendQuery {
    months: Option<i32>,
}

#[derive(Serialize)]
struct TrendRow {
    category_id: Option<i64>,
    values: Vec<i64>,
    total: i64,
    average: i64,
}

async fn trends(State(app): State<Arc<AppState>>, Query(q): Query<TrendQuery>) -> ApiResult<Value> {
    let conn = app.db.lock().unwrap();
    let months = months_available(&conn)?;
    let (Some(first), Some(last)) = (months.first().and_then(|m| ym(m)), months.last().and_then(|m| ym(m))) else {
        return Ok(Json(json!({ "months": [], "rows": [], "expenses": [], "income": [] })));
    };
    let n = q.months.unwrap_or(12).clamp(3, 36);
    let span: Vec<Ym> = (0..n).rev().map(|k| add_months(last, -k)).filter(|m| *m >= first).collect();
    let labels: Vec<String> = span.iter().map(|m| fmt_ym(*m)).collect();
    let idx: HashMap<&str, usize> = labels.iter().enumerate().map(|(i, m)| (m.as_str(), i)).collect();

    let mut rows: HashMap<Option<i64>, Vec<i64>> = HashMap::new();
    let mut expenses = vec![0i64; labels.len()];
    let mut income = vec![0i64; labels.len()];
    let mut stmt = conn.prepare(
        "SELECT category_id, kind, month, SUM(amount_cents) FROM ledger
         WHERE kind IN ('expense', 'income') AND month BETWEEN ?1 AND ?2 GROUP BY category_id, kind, month",
    )?;
    let it = stmt.query_map(params![labels[0], labels[labels.len() - 1]], |r| {
        Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))
    })?;
    for row in it {
        let (cat, kind, m, sum) = row?;
        let Some(&i) = idx.get(m.as_str()) else { continue };
        if kind == "expense" {
            rows.entry(cat).or_insert_with(|| vec![0; labels.len()])[i] += -sum;
            expenses[i] += -sum;
        } else {
            income[i] += sum;
        }
    }
    let mut out: Vec<TrendRow> = rows
        .into_iter()
        .map(|(category_id, values)| {
            let total: i64 = values.iter().sum();
            TrendRow { category_id, average: total / values.len().max(1) as i64, total, values }
        })
        .filter(|r| r.total != 0)
        .collect();
    out.sort_by(|a, b| b.total.cmp(&a.total));
    Ok(Json(json!({ "months": labels, "rows": out, "expenses": expenses, "income": income })))
}

// ---------- Paiements récurrents ----------

async fn recurring(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let items = crate::budget::detect_recurring(&app.db.lock().unwrap())?;
    let monthly = |kind: &str, fixed: Option<bool>| -> i64 {
        items
            .iter()
            .filter(|r| r.status != "stopped" && r.kind == kind && fixed.is_none_or(|f| r.fixed == f))
            .map(|r| r.monthly_cents)
            .sum()
    };
    Ok(Json(json!({
        "subscriptions_monthly_cents": monthly("expense", Some(true)),
        "recurring_expenses_monthly_cents": monthly("expense", Some(false)),
        "recurring_income_monthly_cents": monthly("income", None),
        "monthly_total_cents": monthly("expense", None),
        "items": items,
    })))
}

#[derive(Deserialize)]
struct ManualRecurring {
    name: String,
    pattern: String,
    cadence: String,
    #[serde(default = "default_expense")]
    kind: String,
    category_id: Option<i64>,
    expected_cents: Option<i64>,
}
fn default_expense() -> String {
    "expense".into()
}

async fn add_manual_recurring(State(app): State<Arc<AppState>>, Json(b): Json<ManualRecurring>) -> ApiResult<Value> {
    let pattern = b.pattern.split_whitespace().collect::<Vec<_>>().join(" ");
    if b.name.trim().is_empty() || pattern.chars().count() < 2 || pattern.len() > 80 {
        return Err(ApiError::bad("nom ou motif invalide"));
    }
    if !["weekly", "monthly", "quarterly", "yearly"].contains(&b.cadence.as_str()) || !["expense", "income"].contains(&b.kind.as_str()) {
        return Err(ApiError::bad("cadence ou type invalide"));
    }
    let conn = app.db.lock().unwrap();
    if let Some(c) = b.category_id {
        ensure_category(&conn, c)?;
    }
    conn.execute(
        "INSERT INTO recurring_manual (name, pattern, cadence, kind, category_id, expected_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![b.name.trim(), pattern, b.cadence, b.kind, b.category_id, b.expected_cents, db::now()],
    )?;
    Ok(Json(json!({ "id": conn.last_insert_rowid() })))
}

async fn delete_manual_recurring(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    if app.db.lock().unwrap().execute("DELETE FROM recurring_manual WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::not_found("récurrent inconnu"));
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- Opérations ----------

#[derive(Deserialize)]
struct TxQuery {
    month: Option<String>,
    category: Option<String>,
    account: Option<String>,
    q: Option<String>,
    kind: Option<String>,
    source: Option<String>,
    /// Masque les virements entre mes comptes et l'épargne.
    hide_transfers: Option<bool>,
    /// « only » : seulement les opérations exclues.
    excluded: Option<String>,
    /// « out » : dépenses qu'aucun poste du budget actif n'attrape.
    budget: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
struct Tx {
    id: i64,
    day: String,
    label: String,
    counterparty: Option<String>,
    merchant: Option<String>,
    amount_cents: i64,
    currency: String,
    status: String,
    account_id: String,
    bank: String,
    category_id: Option<i64>,
    category_source: Option<String>,
    category_confidence: Option<f64>,
    kind: String,
    excluded: bool,
}

async fn transactions(State(app): State<Arc<AppState>>, Query(q): Query<TxQuery>) -> ApiResult<Value> {
    let mut wh: Vec<String> = vec!["1 = 1".into()];
    let mut ps: Vec<Sql> = Vec::new();
    if let Some(m) = q.month.as_deref().filter(|m| ym(m).is_some()) {
        wh.push("l.month = ?".into());
        ps.push(Sql::Text(m.to_string()));
    }
    match q.category.as_deref() {
        Some("none") => wh.push("l.category_id IS NULL".into()),
        Some(c) => {
            let id: i64 = c.parse().map_err(|_| ApiError::bad("catégorie invalide"))?;
            wh.push("l.category_id = ?".into());
            ps.push(Sql::Integer(id));
        }
        None => {}
    }
    if let Some(a) = q.account.as_deref().filter(|a| !a.is_empty()) {
        wh.push("l.account_hash = ?".into());
        ps.push(Sql::Text(a.to_string()));
    }
    if let Some(k) = q.kind.as_deref().filter(|k| ["expense", "income", "transfer"].contains(k)) {
        wh.push("l.kind = ?".into());
        ps.push(Sql::Text(k.to_string()));
    }
    if q.excluded.as_deref() == Some("only") {
        wh.push("l.excluded = 1".into());
    }
    if q.budget.as_deref() == Some("out") {
        // Même règle que le suivi du budget (budget::line_matches) : bon sens, puis motif sinon catégorie.
        wh.push(
            "l.kind = 'expense' AND l.excluded = 0 AND NOT EXISTS (
                SELECT 1 FROM budget_lines bl
                WHERE bl.budget_id = (SELECT id FROM budgets ORDER BY is_active DESC, created_at DESC LIMIT 1)
                  AND CASE WHEN bl.kind IN ('income', 'salary') THEN l.amount_cents > 0 ELSE l.amount_cents < 0 END
                  AND CASE WHEN trim(COALESCE(bl.match, '')) <> ''
                           THEN instr(upper(l.label || ' ' || COALESCE(l.counterparty, '') || ' ' || COALESCE(l.merchant, '')), upper(bl.match)) > 0
                           ELSE bl.category_id IS NOT NULL AND bl.category_id = l.category_id END)"
                .into(),
        );
    }
    if q.hide_transfers == Some(true) && q.kind.as_deref() != Some("transfer") {
        wh.push("l.kind <> 'transfer'".into());
    }
    match q.source.as_deref() {
        Some("review") => wh.push("l.category_source = 'ai' AND l.category_confidence < 0.6".into()),
        Some(s) if ["user", "rule", "memory", "transfer", "ai"].contains(&s) => {
            wh.push("l.category_source = ?".into());
            ps.push(Sql::Text(s.to_string()));
        }
        _ => {}
    }
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        wh.push(
            "(l.label LIKE ? ESCAPE '\\' OR l.counterparty LIKE ? ESCAPE '\\' OR l.merchant LIKE ? ESCAPE '\\')".into(),
        );
        let like = format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        for _ in 0..3 {
            ps.push(Sql::Text(like.clone()));
        }
    }
    let where_sql = wh.join(" AND ");
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);

    let conn = app.db.lock().unwrap();
    let (total, income, expenses): (i64, i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'income' AND NOT excluded), 0),
                    COALESCE(-SUM(amount_cents) FILTER (WHERE kind = 'expense' AND NOT excluded), 0)
             FROM ledger_all l WHERE {where_sql}"
        ),
        params_from_iter(ps.iter()),
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let mut page_ps = ps.clone();
    page_ps.push(Sql::Integer(limit));
    page_ps.push(Sql::Integer(offset));
    let items: Vec<Tx> = conn
        .prepare(&format!(
            "SELECT l.id, l.day, l.label, l.counterparty, l.merchant, l.amount_cents, l.currency, l.status,
                    l.account_hash, a.aspsp_name, l.category_id, l.category_source, l.category_confidence, l.kind, l.excluded
             FROM ledger_all l JOIN accounts a ON a.hash = l.account_hash
             WHERE {where_sql} ORDER BY l.day DESC, l.id DESC LIMIT ? OFFSET ?"
        ))?
        .query_map(params_from_iter(page_ps.iter()), |r| {
            Ok(Tx {
                id: r.get(0)?,
                day: r.get(1)?,
                label: r.get(2)?,
                counterparty: r.get(3)?,
                merchant: r.get(4)?,
                amount_cents: r.get(5)?,
                currency: r.get(6)?,
                status: r.get(7)?,
                account_id: r.get(8)?,
                bank: r.get(9)?,
                category_id: r.get(10)?,
                category_source: r.get(11)?,
                category_confidence: r.get(12)?,
                kind: r.get(13)?,
                excluded: r.get(14)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(json!({ "total": total, "income_cents": income, "expenses_cents": expenses, "items": items })))
}

#[derive(Deserialize)]
struct TxUpdate {
    /// Absent = inchangée, null = retour au classement automatique.
    #[serde(default, deserialize_with = "nullable")]
    category_id: Option<Option<i64>>,
    /// Exclure (ou réintégrer) l'opération des statistiques et du budget.
    excluded: Option<bool>,
}

async fn update_transaction(
    State(app): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<TxUpdate>,
) -> ApiResult<Value> {
    let mut conn = app.db.lock().unwrap();
    let merchant: Option<Option<String>> =
        conn.query_row("SELECT merchant FROM transactions WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    let Some(merchant) = merchant else { return Err(ApiError::not_found("opération inconnue")) };
    if let Some(ex) = body.excluded {
        conn.execute("UPDATE transactions SET excluded = ?1 WHERE id = ?2", params![ex, id])?;
        if body.category_id.is_none() {
            return Ok(Json(json!({ "similar_updated": 0, "excluded": ex })));
        }
    }
    let Some(category) = body.category_id else { return Err(ApiError::bad("rien à modifier")) };
    match category {
        Some(cat) => {
            ensure_category(&conn, cat)?;
            conn.execute(
                "UPDATE transactions SET category_id = ?1, category_source = 'user', category_confidence = 1 WHERE id = ?2",
                params![cat, id],
            )?;
        }
        // Retour à la catégorisation automatique.
        None => {
            conn.execute(
                "UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL WHERE id = ?1",
                [id],
            )?;
        }
    }
    let stats = categorize::apply_deterministic(&mut conn)?;
    let similar: i64 = match &merchant {
        Some(m) => conn.query_row(
            "SELECT COUNT(*) FROM transactions WHERE merchant = ?1 AND category_source = 'memory'
               AND (amount_cents < 0) = (SELECT amount_cents < 0 FROM transactions WHERE id = ?2)",
            params![m, id],
            |r| r.get(0),
        )?,
        None => 0,
    };
    Ok(Json(json!({ "similar_updated": similar, "stats": stats })))
}

fn ensure_category(conn: &Connection, id: i64) -> Result<(), ApiError> {
    let ok: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1)", [id], |r| r.get(0))?;
    if ok { Ok(()) } else { Err(ApiError::bad("catégorie inconnue")) }
}

// ---------- Catégories ----------

#[derive(Serialize)]
struct Category {
    id: i64,
    name: String,
    icon: String,
    kind: String,
    description: String,
    budget_cents: Option<i64>,
    position: i64,
    role: Option<String>,
    tx_count: i64,
    nature: Option<String>,
}

async fn list_categories(State(app): State<Arc<AppState>>) -> ApiResult<Vec<Category>> {
    let conn = app.db.lock().unwrap();
    let rows = conn
        .prepare(
            "SELECT c.id, c.name, c.icon, c.kind, c.description, c.budget_cents, c.position, c.role,
                    (SELECT COUNT(*) FROM ledger l WHERE l.category_id = c.id), c.nature
             FROM categories c ORDER BY CASE c.kind WHEN 'expense' THEN 0 WHEN 'income' THEN 1 ELSE 2 END, c.position, c.name",
        )?
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                kind: r.get(3)?,
                description: r.get(4)?,
                budget_cents: r.get(5)?,
                position: r.get(6)?,
                role: r.get(7)?,
                tx_count: r.get(8)?,
                nature: r.get(9)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct CategoryInput {
    name: Option<String>,
    icon: Option<String>,
    kind: Option<String>,
    description: Option<String>,
    /// Absent = inchangé, null = pas de budget.
    #[serde(default, deserialize_with = "nullable")]
    budget_cents: Option<Option<i64>>,
    /// Absent = inchangé, null = non définie.
    #[serde(default, deserialize_with = "nullable_str")]
    nature: Option<Option<String>>,
}

fn nullable_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
    Ok(Some(Option::<i64>::deserialize(d)?))
}

fn validate_category(name: Option<&str>, icon: Option<&str>, kind: Option<&str>) -> Result<(), ApiError> {
    if let Some(n) = name {
        if n.trim().is_empty() || n.len() > 60 {
            return Err(ApiError::bad("nom de catégorie invalide (1 à 60 caractères)"));
        }
    }
    if let Some(i) = icon {
        let ok = i.len() <= 80
            && i.split_once(':').is_some_and(|(p, n)| !p.is_empty() && !n.is_empty())
            && i.chars().all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '-');
        if !ok {
            return Err(ApiError::bad("icône invalide (format Iconify, ex. lucide:shopping-cart)"));
        }
    }
    if let Some(k) = kind {
        if !["expense", "income", "transfer"].contains(&k) {
            return Err(ApiError::bad("type invalide"));
        }
    }
    Ok(())
}

async fn create_category(State(app): State<Arc<AppState>>, Json(b): Json<CategoryInput>) -> ApiResult<Value> {
    let (Some(name), Some(kind)) = (b.name.as_deref(), b.kind.as_deref()) else {
        return Err(ApiError::bad("nom et type requis"));
    };
    let icon = b.icon.as_deref().unwrap_or("lucide:tag");
    validate_category(Some(name), Some(icon), Some(kind))?;
    let conn = app.db.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO categories (name, icon, kind, description, budget_cents, position)
         VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(position), 0) + 1 FROM categories))",
        params![name.trim(), icon, kind, b.description.as_deref().unwrap_or("").trim(), b.budget_cents.flatten()],
    );
    match res {
        Ok(_) => Ok(Json(json!({ "id": conn.last_insert_rowid() }))),
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            Err(ApiError::bad("une catégorie porte déjà ce nom"))
        }
        Err(e) => Err(e.into()),
    }
}

async fn update_category(
    State(app): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(b): Json<CategoryInput>,
) -> ApiResult<Value> {
    validate_category(b.name.as_deref(), b.icon.as_deref(), b.kind.as_deref())?;
    if let Some(Some(n)) = &b.nature {
        if n != "vital" && n != "plaisir" {
            return Err(ApiError::bad("nature invalide (vital ou plaisir)"));
        }
    }
    let conn = app.db.lock().unwrap();
    ensure_category(&conn, id)?;
    if let Some(n) = &b.nature {
        conn.execute("UPDATE categories SET nature = ?1 WHERE id = ?2", params![n, id])?;
    }
    let res = conn.execute(
        "UPDATE categories SET
            name = COALESCE(?1, name), icon = COALESCE(?2, icon), kind = COALESCE(?3, kind),
            description = COALESCE(?4, description),
            budget_cents = CASE WHEN ?5 THEN ?6 ELSE budget_cents END
         WHERE id = ?7",
        params![
            b.name.as_deref().map(str::trim),
            b.icon,
            b.kind,
            b.description.as_deref().map(str::trim),
            b.budget_cents.is_some(),
            b.budget_cents.flatten().filter(|v| *v > 0),
            id
        ],
    );
    match res {
        Ok(_) => Ok(Json(json!({ "ok": true }))),
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            Err(ApiError::bad("une catégorie porte déjà ce nom"))
        }
        Err(e) => Err(e.into()),
    }
}

async fn delete_category(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    let mut conn = app.db.lock().unwrap();
    ensure_category(&conn, id)?;
    // Les opérations concernées repassent en « non classé » (ON DELETE SET NULL) ; les règles sont supprimées.
    conn.execute(
        "UPDATE transactions SET category_source = NULL, category_confidence = NULL WHERE category_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM categories WHERE id = ?1", [id])?;
    let stats = categorize::apply_deterministic(&mut conn)?;
    Ok(Json(json!({ "ok": true, "stats": stats })))
}

// ---------- Règles ----------

async fn list_rules(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let conn = app.db.lock().unwrap();
    let rules: Vec<Value> = conn
        .prepare(
            "SELECT r.id, r.pattern, r.category_id, r.created_at,
                    (SELECT COUNT(*) FROM transactions t
                     WHERE instr(upper(t.label || ' ' || COALESCE(t.counterparty, '') || ' ' || COALESCE(t.merchant, '')),
                                 upper(r.pattern)) > 0)
             FROM rules r ORDER BY r.id DESC",
        )?
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "pattern": r.get::<_, String>(1)?,
                "category_id": r.get::<_, i64>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "matches": r.get::<_, i64>(4)?,
            }))
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(json!(rules)))
}

#[derive(Deserialize)]
struct RuleInput {
    pattern: String,
    category_id: i64,
}

fn clean_pattern(p: &str) -> Result<String, ApiError> {
    let pattern = p.split_whitespace().collect::<Vec<_>>().join(" ");
    if pattern.chars().count() < 2 || pattern.len() > 80 {
        return Err(ApiError::bad("motif trop court ou trop long"));
    }
    Ok(pattern)
}

async fn create_rule(State(app): State<Arc<AppState>>, Json(b): Json<RuleInput>) -> ApiResult<Value> {
    let pattern = clean_pattern(&b.pattern)?;
    let mut conn = app.db.lock().unwrap();
    ensure_category(&conn, b.category_id)?;
    conn.execute(
        "INSERT INTO rules (pattern, category_id, created_at) VALUES (?1, ?2, ?3)",
        params![pattern, b.category_id, db::now()],
    )?;
    let stats = categorize::apply_deterministic(&mut conn)?;
    Ok(Json(json!({ "id": conn.last_insert_rowid(), "stats": stats })))
}

#[derive(Deserialize)]
struct RulesInput {
    patterns: Vec<String>,
    category_id: i64,
}

/// Plusieurs motifs vers une même catégorie (suggestion acceptée), appliqués en une fois.
async fn create_rules(State(app): State<Arc<AppState>>, Json(b): Json<RulesInput>) -> ApiResult<Value> {
    let patterns: Vec<String> = b.patterns.iter().map(|p| clean_pattern(p)).collect::<Result<_, _>>()?;
    if patterns.is_empty() || patterns.len() > 20 {
        return Err(ApiError::bad("de 1 à 20 motifs"));
    }
    let mut conn = app.db.lock().unwrap();
    ensure_category(&conn, b.category_id)?;
    {
        let tx = conn.transaction()?;
        for p in &patterns {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM rules WHERE upper(pattern) = upper(?1) AND category_id = ?2)",
                params![p, b.category_id],
                |r| r.get(0),
            )?;
            if !exists {
                tx.execute(
                    "INSERT INTO rules (pattern, category_id, created_at) VALUES (?1, ?2, ?3)",
                    params![p, b.category_id, db::now()],
                )?;
            }
        }
        tx.commit()?;
    }
    let stats = categorize::apply_deterministic(&mut conn)?;
    Ok(Json(json!({ "ok": true, "stats": stats })))
}

async fn rule_suggestions(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let conn = app.db.lock().unwrap();
    let items = suggest::suggestions(&conn)?;
    let dismissed = suggest::dismissed(&conn)?.len();
    Ok(Json(json!({ "items": items, "dismissed": dismissed })))
}

#[derive(Deserialize)]
struct DismissInput {
    key: String,
}

async fn dismiss_suggestion(State(app): State<Arc<AppState>>, Json(b): Json<DismissInput>) -> ApiResult<Value> {
    if b.key.is_empty() || b.key.len() > 500 {
        return Err(ApiError::bad("suggestion invalide"));
    }
    suggest::dismiss(&app.db.lock().unwrap(), &b.key)?;
    Ok(Json(json!({ "ok": true })))
}

/// Fait réapparaître les suggestions ignorées.
async fn reset_suggestions(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    suggest::reset_dismissed(&app.db.lock().unwrap())?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_rule(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    let mut conn = app.db.lock().unwrap();
    if conn.execute("DELETE FROM rules WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::not_found("règle inconnue"));
    }
    let stats = categorize::apply_deterministic(&mut conn)?;
    Ok(Json(json!({ "ok": true, "stats": stats })))
}

// ---------- Actions ----------

async fn start_sync(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let already = app.syncing.load(Ordering::SeqCst);
    sync::spawn(app);
    Ok(Json(json!({ "started": !already })))
}

#[derive(Deserialize, Default)]
struct ClassifyInput {
    #[serde(default)]
    reclassify: bool,
}

async fn start_classify(State(app): State<Arc<AppState>>, body: Option<Json<ClassifyInput>>) -> ApiResult<Value> {
    let reclassify = body.map(|b| b.0.reclassify).unwrap_or(false);
    let stats = categorize::apply_deterministic(&mut app.db.lock().unwrap())?;
    let ai = app.ai.is_some();
    if ai {
        categorize::spawn_ai(app.clone(), reclassify);
    }
    Ok(Json(json!({ "stats": stats, "ai_started": ai })))
}

async fn cancel_classify(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let running = app.classifying.load(Ordering::SeqCst);
    if running {
        app.ai_cancel.store(true, Ordering::SeqCst);
    }
    Ok(Json(json!({ "cancelling": running })))
}

// ---------- Connexion bancaire ----------

const ASPSP_CACHE_TTL: Duration = Duration::from_secs(24 * 3600);

async fn aspsps(app: &AppState) -> anyhow::Result<Vec<crate::eb::Aspsp>> {
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

async fn banks(State(app): State<Arc<AppState>>) -> ApiResult<Value> {
    let list = aspsps(&app).await?;
    Ok(Json(json!(
        list.iter().map(|a| json!({ "name": a.name, "country": a.country, "beta": a.beta })).collect::<Vec<_>>()
    )))
}

#[derive(Deserialize)]
struct ConnectInput {
    name: String,
    country: String,
}

async fn connect(State(app): State<Arc<AppState>>, Json(b): Json<ConnectInput>) -> ApiResult<Value> {
    let (Some(client), Some(cfg)) = (app.eb.as_ref(), app.cfg.enable_banking.as_ref()) else {
        return Err(ApiError::bad("Enable Banking n'est pas configuré"));
    };
    let list = aspsps(&app).await?;
    let aspsp = list
        .iter()
        .find(|a| a.name == b.name && a.country == b.country)
        .ok_or_else(|| ApiError::bad(format!("banque inconnue : {} ({})", b.name, b.country)))?;

    let wanted = cfg.consent_days * 86_400;
    let secs = aspsp.maximum_consent_validity.map_or(wanted, |max| wanted.min(max - 60)).max(3600);
    let valid_until =
        (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
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
    Ok(Json(json!({ "url": resp.url })))
}

#[cfg(test)]
mod summary_tests {
    use super::*;

    fn conn() -> Connection {
        let conn = db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute("INSERT INTO accounts (hash, aspsp_name, currency, raw) VALUES ('test', 'Test', 'EUR', '{}')", []).unwrap();
        conn
    }

    fn add(conn: &Connection, id: i64, day: &str, amount: i64, kind: &str, excluded: bool) {
        let category: i64 = conn.query_row("SELECT id FROM categories WHERE kind = ?1 ORDER BY id LIMIT 1", [kind], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO transactions (account_hash, fingerprint, status, booking_date, amount_cents, currency, label, raw, first_seen, category_id, excluded)
             VALUES ('test', ?1, 'BOOK', ?2, ?3, 'EUR', 'Test', '{}', ?2, ?4, ?5)",
            params![id.to_string(), day, amount, category, excluded],
        ).unwrap();
    }

    fn report(conn: &Connection, month: &str, day: &str) -> Summary {
        summarize(conn, Some(month.into()), chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap())
            .unwrap_or_else(|error| panic!("{}", error.message))
    }

    #[test]
    fn previous_months_cross_year_and_keep_refunds_and_exclusions() {
        let conn = conn();
        add(&conn, 1, "2026-11-30", -2000, "expense", false);
        add(&conn, 2, "2026-12-01", -1000, "expense", false);
        add(&conn, 3, "2026-12-31", 200, "expense", false);
        add(&conn, 4, "2026-12-02", -99000, "expense", true);
        add(&conn, 5, "2026-12-03", -50000, "transfer", false);
        add(&conn, 6, "2026-12-04", 70000, "income", false);
        add(&conn, 7, "2027-01-02", -500, "expense", false);
        let summary = report(&conn, "2027-01", "2027-01-15");
        assert_eq!(summary.cumulative_current.len(), 15);
        assert_eq!(summary.cumulative_current.last(), Some(&500));
        assert_eq!(summary.cumulative_previous.iter().map(|m| m.month.as_str()).collect::<Vec<_>>(), ["2026-12", "2026-11"]);
        assert_eq!(summary.cumulative_previous[0].values.len(), 31);
        assert_eq!(summary.cumulative_previous[0].values[29], 1000);
        assert_eq!(summary.cumulative_previous[0].values[30], 800);
        assert_eq!(summary.cumulative_previous[1].values.len(), 30);
        assert_eq!(summary.cumulative_previous[1].values.last(), Some(&2000));
    }

    #[test]
    fn previous_months_keep_february_twenty_ninth() {
        let conn = conn();
        add(&conn, 1, "2024-01-31", -100, "expense", false);
        add(&conn, 2, "2024-02-29", -300, "expense", false);
        add(&conn, 3, "2024-03-01", -500, "expense", false);
        let summary = report(&conn, "2024-03", "2024-03-15");
        assert_eq!(summary.cumulative_previous[0].month, "2024-02");
        assert_eq!(summary.cumulative_previous[0].values.len(), 29);
        assert_eq!(summary.cumulative_previous[0].values[27], 0);
        assert_eq!(summary.cumulative_previous[0].values[28], 300);
        assert_eq!(summary.cumulative_previous[1].values.len(), 31);
    }

    #[test]
    fn previous_months_include_zero_activity_without_skipping_a_month() {
        let conn = conn();
        add(&conn, 1, "2026-11-01", -900, "expense", false);
        add(&conn, 2, "2027-01-01", -100, "expense", false);
        let summary = report(&conn, "2027-01", "2027-01-15");
        assert_eq!(summary.cumulative_previous[0].month, "2026-12");
        assert_eq!(summary.cumulative_previous[0].values, vec![0; 31]);
        assert_eq!(summary.cumulative_previous[1].month, "2026-11");
        assert_eq!(summary.cumulative_previous[1].values.last(), Some(&900));
    }

    #[test]
    fn balance_deducts_pending_expenses_only_from_booked_balances() {
        let conn = conn();
        conn.execute("UPDATE accounts SET balance_cents = 10000, balance_type = 'CLBD' WHERE hash = 'test'", []).unwrap();
        conn.execute(
            "INSERT INTO accounts (hash, aspsp_name, currency, raw, balance_cents, balance_type) VALUES ('rev', 'Rev', 'EUR', '{}', 5600, 'ITAV')",
            [],
        )
        .unwrap();
        let pending = |account: &str, id: &str, amount: i64| {
            conn.execute(
                "INSERT INTO transactions (account_hash, fingerprint, status, transaction_date, amount_cents, currency, label, raw, first_seen)
                 VALUES (?1, ?2, 'PDNG', '2026-11-15', ?3, 'EUR', 'Test', '{}', '2026-11-15')",
                params![account, id, amount],
            )
            .unwrap();
        };
        pending("test", "p1", -4000);
        pending("test", "p2", -373);
        pending("test", "p3", 500); // un remboursement en attente n'est pas compté d'avance
        pending("rev", "p4", -15673); // déjà déduit du solde disponible
        add(&conn, 1, "2026-11-14", -1000, "expense", false); // comptabilisé : déjà dans le solde
        let summary = report(&conn, "2026-11", "2026-11-20");
        assert_eq!(summary.pending_cents, -4373);
        assert_eq!(summary.balance_cents, 10000 - 4373 + 5600);
    }

    #[test]
    fn previous_months_do_not_invent_history_before_the_first_month() {
        let conn = conn();
        let empty = report(&conn, "2027-01", "2027-01-15");
        assert!(empty.cumulative_previous.is_empty());
        add(&conn, 1, "2027-01-03", -100, "expense", false);
        let first = report(&conn, "2027-01", "2027-01-15");
        assert!(first.cumulative_previous.is_empty());
    }
}
