//! API des budgets : CRUD (budgets, périodes, postes, montants), import, suivi dynamique.

use super::api::{ApiError, ApiResult};
use crate::budget::{self, ImportBudget, ImportPeriod};
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/budgets", get(list).post(create))
        .route("/budgets/import", post(import))
        .route("/budgets/{id}", get(one).patch(update).delete(remove))
        .route("/budgets/{id}/tracking", get(track))
        .route("/budgets/{id}/calendar", patch(update_calendar))
        .route("/budgets/{id}/periods", post(add_period))
        .route("/budgets/{id}/lines", post(add_line))
        .route("/budget-periods/{id}", patch(update_period).delete(delete_period))
        .route("/budget-lines/{id}", patch(update_line).delete(delete_line))
}

/// Champ facultatif et « effaçable » : absent = inchangé, null = effacer.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Ok(Some(Option::<T>::deserialize(d)?))
}

fn check_name(n: &str) -> Result<(), ApiError> {
    if n.trim().is_empty() || n.chars().count() > 80 {
        return Err(ApiError::bad("nom invalide (1 à 80 caractères)"));
    }
    Ok(())
}
fn check_month(m: &str) -> Result<(), ApiError> {
    let ok = m.len() == 7
        && m.as_bytes()[4] == b'-'
        && m[..4].parse::<u32>().is_ok()
        && m[5..].parse::<u32>().is_ok_and(|x| (1..=12).contains(&x));
    if ok { Ok(()) } else { Err(ApiError::bad("mois invalide (AAAA-MM)")) }
}
fn check_amount(c: i64) -> Result<(), ApiError> {
    if c.abs() > 1_000_000_000 {
        return Err(ApiError::bad("montant hors limites"));
    }
    Ok(())
}
fn exists(conn: &Connection, table: &str, id: i64) -> Result<bool, ApiError> {
    Ok(conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"), [id], |r| r.get(0))?)
}

// ---------- Budgets ----------

async fn list(State(app): State<Arc<AppState>>) -> ApiResult<Vec<budget::Budget>> {
    Ok(Json(budget::list(&app.db.lock().unwrap())?))
}

async fn one(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<budget::Budget> {
    budget::get(&app.db.lock().unwrap(), id)?.map(Json).ok_or_else(|| ApiError::not_found("budget inconnu"))
}

#[derive(Deserialize)]
struct CreateInput {
    name: String,
    /// empty | detected | copy
    #[serde(default)]
    mode: String,
    source_id: Option<i64>,
    #[serde(default)]
    periods: Vec<PeriodInput>,
}

#[derive(Deserialize)]
struct PeriodInput {
    name: String,
    months: Option<i64>,
    start_month: Option<String>,
}

async fn create(State(app): State<Arc<AppState>>, Json(b): Json<CreateInput>) -> ApiResult<Value> {
    check_name(&b.name)?;
    let mut conn = app.db.lock().unwrap();
    let id = match b.mode.as_str() {
        "detected" => budget::from_detected(&mut conn, b.name.trim())?,
        "copy" => {
            let src = b.source_id.ok_or_else(|| ApiError::bad("budget à copier manquant"))?;
            budget::duplicate(&mut conn, src, b.name.trim())?
        }
        _ => {
            for p in &b.periods {
                check_name(&p.name)?;
                if let Some(m) = &p.start_month {
                    check_month(m)?;
                }
            }
            let periods = if b.periods.is_empty() {
                vec![ImportPeriod { name: "Mensuel".into(), months: 12, start_month: None }]
            } else {
                b.periods
                    .iter()
                    .map(|p| ImportPeriod { name: p.name.trim().into(), months: p.months.unwrap_or(1), start_month: p.start_month.clone() })
                    .collect()
            };
            budget::import(&mut conn, &ImportBudget { name: b.name.trim().into(), notes: String::new(), active: false, periods, lines: vec![], calendar: HashMap::new() })?
        }
    };
    // Le premier budget créé devient actif.
    conn.execute(
        "UPDATE budgets SET is_active = 1 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM budgets WHERE is_active = 1)",
        [id],
    )?;
    Ok(Json(json!({ "id": id })))
}

async fn import(State(app): State<Arc<AppState>>, Json(b): Json<ImportBudget>) -> ApiResult<Value> {
    check_name(&b.name)?;
    let id = budget::import(&mut app.db.lock().unwrap(), &b).map_err(|e| ApiError::bad(format!("{e:#}")))?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct BudgetUpdate {
    name: Option<String>,
    notes: Option<String>,
    is_active: Option<bool>,
}

async fn update(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Json(b): Json<BudgetUpdate>) -> ApiResult<Value> {
    if let Some(n) = &b.name {
        check_name(n)?;
    }
    let mut conn = app.db.lock().unwrap();
    if !exists(&conn, "budgets", id)? {
        return Err(ApiError::not_found("budget inconnu"));
    }
    let tx = conn.transaction()?;
    if b.is_active == Some(true) {
        tx.execute("UPDATE budgets SET is_active = 0", [])?;
    }
    tx.execute(
        "UPDATE budgets SET name = COALESCE(?1, name), notes = COALESCE(?2, notes), is_active = COALESCE(?3, is_active) WHERE id = ?4",
        params![b.name.as_deref().map(str::trim), b.notes, b.is_active, id],
    )?;
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    let conn = app.db.lock().unwrap();
    if conn.execute("DELETE FROM budgets WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::not_found("budget inconnu"));
    }
    // Toujours un budget actif s'il en reste.
    conn.execute(
        "UPDATE budgets SET is_active = 1 WHERE id = (SELECT id FROM budgets ORDER BY created_at DESC LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM budgets WHERE is_active = 1)",
        [],
    )?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct TrackQuery {
    month: Option<String>,
    period: Option<i64>,
}

async fn track(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Query(q): Query<TrackQuery>) -> ApiResult<budget::Tracking> {
    let conn = app.db.lock().unwrap();
    if !exists(&conn, "budgets", id)? {
        return Err(ApiError::not_found("budget inconnu"));
    }
    Ok(Json(budget::tracking(&conn, id, q.month.as_deref(), q.period)?))
}

/// Affecte des mois à des périodes (null = retirer le mois du calendrier).
async fn update_calendar(
    State(app): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(b): Json<HashMap<String, Option<i64>>>,
) -> ApiResult<Value> {
    let mut conn = app.db.lock().unwrap();
    if !exists(&conn, "budgets", id)? {
        return Err(ApiError::not_found("budget inconnu"));
    }
    let tx = conn.transaction()?;
    for (month, period) in &b {
        check_month(month)?;
        match period {
            Some(p) => {
                let ok: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM budget_periods WHERE id = ?1 AND budget_id = ?2)",
                    params![p, id],
                    |r| r.get(0),
                )?;
                if !ok {
                    return Err(ApiError::bad("période d'un autre budget"));
                }
                tx.execute(
                    "INSERT OR REPLACE INTO budget_calendar (budget_id, month, period_id) VALUES (?1, ?2, ?3)",
                    params![id, month, p],
                )?;
            }
            None => {
                tx.execute("DELETE FROM budget_calendar WHERE budget_id = ?1 AND month = ?2", params![id, month])?;
            }
        }
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- Périodes ----------

async fn add_period(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Json(p): Json<PeriodInput>) -> ApiResult<Value> {
    check_name(&p.name)?;
    if let Some(m) = &p.start_month {
        check_month(m)?;
    }
    let conn = app.db.lock().unwrap();
    if !exists(&conn, "budgets", id)? {
        return Err(ApiError::not_found("budget inconnu"));
    }
    conn.execute(
        "INSERT INTO budget_periods (budget_id, name, months, start_month, position)
         VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position), -1) + 1 FROM budget_periods WHERE budget_id = ?1))",
        params![id, p.name.trim(), p.months.unwrap_or(1).clamp(1, 24), p.start_month],
    )?;
    Ok(Json(json!({ "id": conn.last_insert_rowid() })))
}

#[derive(Deserialize)]
struct PeriodUpdate {
    name: Option<String>,
    months: Option<i64>,
    #[serde(default, deserialize_with = "nullable")]
    start_month: Option<Option<String>>,
}

async fn update_period(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Json(p): Json<PeriodUpdate>) -> ApiResult<Value> {
    if let Some(n) = &p.name {
        check_name(n)?;
    }
    if let Some(Some(m)) = &p.start_month {
        check_month(m)?;
    }
    let conn = app.db.lock().unwrap();
    if !exists(&conn, "budget_periods", id)? {
        return Err(ApiError::not_found("période inconnue"));
    }
    conn.execute(
        "UPDATE budget_periods SET name = COALESCE(?1, name), months = COALESCE(?2, months),
                start_month = CASE WHEN ?3 THEN ?4 ELSE start_month END
         WHERE id = ?5",
        params![p.name.as_deref().map(str::trim), p.months.map(|m| m.clamp(1, 24)), p.start_month.is_some(), p.start_month.flatten(), id],
    )?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_period(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    let conn = app.db.lock().unwrap();
    let budget: Option<i64> =
        conn.query_row("SELECT budget_id FROM budget_periods WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    let Some(budget) = budget else { return Err(ApiError::not_found("période inconnue")) };
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM budget_periods WHERE budget_id = ?1", [budget], |r| r.get(0))?;
    if n <= 1 {
        return Err(ApiError::bad("un budget garde au moins une période"));
    }
    conn.execute("DELETE FROM budget_periods WHERE id = ?1", [id])?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- Postes ----------

#[derive(Deserialize)]
struct LineInput {
    #[serde(default)]
    section: String,
    name: String,
    kind: String,
    category_id: Option<i64>,
    #[serde(rename = "match")]
    pattern: Option<String>,
    once_cents: Option<i64>,
    #[serde(default)]
    amounts: HashMap<String, Option<i64>>,
    scope: Option<String>,
    from_month: Option<String>,
    until_month: Option<String>,
}

#[derive(Deserialize)]
struct LineUpdate {
    section: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    category_id: Option<Option<i64>>,
    #[serde(default, rename = "match", deserialize_with = "nullable")]
    pattern: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    once_cents: Option<Option<i64>>,
    position: Option<i64>,
    #[serde(default)]
    amounts: HashMap<String, Option<i64>>,
    scope: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    from_month: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    until_month: Option<Option<String>>,
}

/// Plage de mois d'un poste : AAAA-MM, début ≤ fin ; vide = sans borne.
fn check_months(from: Option<&str>, until: Option<&str>) -> Result<(), ApiError> {
    for m in [from, until].into_iter().flatten() {
        if !budget::valid_month(m) {
            return Err(ApiError::bad("mois invalide (AAAA-MM)"));
        }
    }
    match (from, until) {
        (Some(f), Some(u)) if f > u => Err(ApiError::bad("le premier mois est après le dernier")),
        _ => Ok(()),
    }
}

fn check_scope(s: Option<&str>) -> Result<(), ApiError> {
    match s {
        None | Some("vie") | Some("alternance") => Ok(()),
        _ => Err(ApiError::bad("périmètre invalide (vie ou alternance)")),
    }
}

fn check_kind(k: &str) -> Result<(), ApiError> {
    if budget::KINDS.contains(&k) { Ok(()) } else { Err(ApiError::bad("type de poste invalide")) }
}

/// Écrit les montants par période (null = vide) après avoir vérifié que les périodes appartiennent au budget.
fn write_amounts(conn: &Connection, budget_id: i64, line_id: i64, amounts: &HashMap<String, Option<i64>>) -> Result<(), ApiError> {
    for (k, v) in amounts {
        let period: i64 = k.parse().map_err(|_| ApiError::bad("période invalide"))?;
        let ok: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM budget_periods WHERE id = ?1 AND budget_id = ?2)",
            params![period, budget_id],
            |r| r.get(0),
        )?;
        if !ok {
            return Err(ApiError::bad("période d'un autre budget"));
        }
        match v {
            Some(c) => {
                check_amount(*c)?;
                conn.execute(
                    "INSERT INTO budget_amounts (line_id, period_id, amount_cents) VALUES (?1, ?2, ?3)
                     ON CONFLICT (line_id, period_id) DO UPDATE SET amount_cents = excluded.amount_cents",
                    params![line_id, period, c],
                )?;
            }
            None => {
                conn.execute("DELETE FROM budget_amounts WHERE line_id = ?1 AND period_id = ?2", params![line_id, period])?;
            }
        }
    }
    Ok(())
}

fn check_category(conn: &Connection, id: Option<i64>) -> Result<(), ApiError> {
    match id {
        Some(c) if !exists(conn, "categories", c)? => Err(ApiError::bad("catégorie inconnue")),
        _ => Ok(()),
    }
}

async fn add_line(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Json(l): Json<LineInput>) -> ApiResult<Value> {
    check_name(&l.name)?;
    check_kind(&l.kind)?;
    check_scope(l.scope.as_deref())?;
    let from = l.from_month.as_deref().map(str::trim).filter(|m| !m.is_empty());
    let until = l.until_month.as_deref().map(str::trim).filter(|m| !m.is_empty());
    check_months(from, until)?;
    if let Some(c) = l.once_cents {
        check_amount(c)?;
    }
    let conn = app.db.lock().unwrap();
    if !exists(&conn, "budgets", id)? {
        return Err(ApiError::not_found("budget inconnu"));
    }
    check_category(&conn, l.category_id)?;
    conn.execute(
        "INSERT INTO budget_lines (budget_id, section, name, kind, category_id, match, once_cents, position, scope, from_month, until_month)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT COALESCE(MAX(position), -1) + 1 FROM budget_lines WHERE budget_id = ?1), ?8, ?9, ?10)",
        params![
            id,
            l.section.trim(),
            l.name.trim(),
            l.kind,
            l.category_id,
            l.pattern.as_deref().map(str::trim).filter(|p| !p.is_empty()),
            l.once_cents,
            l.scope.as_deref().unwrap_or("vie"),
            from,
            until
        ],
    )?;
    let line_id = conn.last_insert_rowid();
    write_amounts(&conn, id, line_id, &l.amounts)?;
    Ok(Json(json!({ "id": line_id })))
}

async fn update_line(State(app): State<Arc<AppState>>, Path(id): Path<i64>, Json(l): Json<LineUpdate>) -> ApiResult<Value> {
    if let Some(n) = &l.name {
        check_name(n)?;
    }
    if let Some(k) = &l.kind {
        check_kind(k)?;
    }
    check_scope(l.scope.as_deref())?;
    if let Some(Some(c)) = l.once_cents {
        check_amount(c)?;
    }
    let conn = app.db.lock().unwrap();
    let budget: Option<i64> = conn.query_row("SELECT budget_id FROM budget_lines WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    let Some(budget) = budget else { return Err(ApiError::not_found("poste inconnu")) };
    check_category(&conn, l.category_id.flatten())?;
    // Plage finale (champ absent = valeur actuelle) pour vérifier début ≤ fin.
    let norm = |m: &Option<Option<String>>| m.clone().map(|v| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    let (from, until) = (norm(&l.from_month), norm(&l.until_month));
    let (cur_from, cur_until): (Option<String>, Option<String>) =
        conn.query_row("SELECT from_month, until_month FROM budget_lines WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    check_months(from.clone().unwrap_or(cur_from).as_deref(), until.clone().unwrap_or(cur_until).as_deref())?;
    conn.execute(
        "UPDATE budget_lines SET
            section = COALESCE(?1, section), name = COALESCE(?2, name), kind = COALESCE(?3, kind),
            category_id = CASE WHEN ?4 THEN ?5 ELSE category_id END,
            match = CASE WHEN ?6 THEN ?7 ELSE match END,
            once_cents = CASE WHEN ?8 THEN ?9 ELSE once_cents END,
            position = COALESCE(?10, position),
            scope = COALESCE(?12, scope),
            from_month = CASE WHEN ?13 THEN ?14 ELSE from_month END,
            until_month = CASE WHEN ?15 THEN ?16 ELSE until_month END
         WHERE id = ?11",
        params![
            l.section.as_deref().map(str::trim),
            l.name.as_deref().map(str::trim),
            l.kind,
            l.category_id.is_some(),
            l.category_id.flatten(),
            l.pattern.is_some(),
            l.pattern.clone().flatten().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
            l.once_cents.is_some(),
            l.once_cents.flatten(),
            l.position,
            id,
            l.scope,
            from.is_some(),
            from.flatten(),
            until.is_some(),
            until.flatten()
        ],
    )?;
    write_amounts(&conn, budget, id, &l.amounts)?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_line(State(app): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    if app.db.lock().unwrap().execute("DELETE FROM budget_lines WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::not_found("poste inconnu"));
    }
    Ok(Json(json!({ "ok": true })))
}
