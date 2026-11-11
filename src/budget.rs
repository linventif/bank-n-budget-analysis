//! Budgets prévisionnels : un budget a des périodes (colonnes, ex. « Toulouse » × 5 mois) et des
//! postes (lignes) avec un montant par période, comme un tableur. Le suivi compare, pour un mois,
//! le prévu au réel (opérations rattachées par motif de libellé ou par catégorie) et au « détecté »
//! (moyenne des 3 mois précédents). Contient aussi la détection des paiements récurrents.

use crate::{db, merchant};
use anyhow::{Result, bail};
use chrono::{Datelike, NaiveDate};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const KINDS: &[&str] = &["expense", "income", "salary", "info"];

// ---------------------------------------------------------------------------
// Paiements récurrents
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct Recurring {
    pub merchant: String,
    pub name: String,
    pub label: String,
    pub category_id: Option<i64>,
    /// expense | income
    pub kind: &'static str,
    /// weekly | monthly | quarterly | yearly
    pub cadence: &'static str,
    /// Montant stable : abonnement ou prélèvement (sinon dépense ou revenu régulier à montant variable).
    pub fixed: bool,
    pub amount_cents: i64,
    pub average_cents: i64,
    pub monthly_cents: i64,
    pub occurrences: usize,
    pub first_day: String,
    pub last_day: String,
    pub next_day: Option<String>,
    pub interval_days: i64,
    /// active | late | stopped
    pub status: &'static str,
}

pub fn detect_recurring(conn: &Connection) -> Result<Vec<Recurring>> {
    let last: Option<String> = conn.query_row("SELECT MAX(day) FROM ledger", [], |r| r.get(0))?;
    let Some(last_data) = last.as_deref().and_then(parse_day) else { return Ok(vec![]) };

    struct Row {
        day: NaiveDate,
        amount: i64,
        cat: Option<i64>,
        label: String,
    }
    let mut groups: HashMap<(String, bool), Vec<Row>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT merchant, day, amount_cents, category_id, label FROM ledger
         WHERE kind IN ('expense', 'income') AND merchant IS NOT NULL AND day >= date(?1, '-420 days')
         ORDER BY day, id",
    )?;
    let rows = stmt.query_map([last_data.to_string()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, String>(4)?))
    })?;
    for row in rows {
        let (m, day, amount, cat, label) = row?;
        if let Some(day) = parse_day(&day) {
            groups.entry((m, amount < 0)).or_default().push(Row { day, amount: amount.abs(), cat, label });
        }
    }

    let mut out = Vec::new();
    for ((m, debit), rows) in groups {
        if rows.len() < 2 {
            continue;
        }
        let mut gaps: Vec<i64> = rows.windows(2).map(|w| (w[1].day - w[0].day).num_days()).filter(|g| *g > 0).collect();
        if gaps.is_empty() {
            continue;
        }
        gaps.sort_unstable();
        let g = gaps[gaps.len() / 2];
        let (cadence, min_occ) = match g {
            5..=9 => ("weekly", 5),
            25..=35 => ("monthly", 3),
            80..=100 => ("quarterly", 3),
            340..=390 => ("yearly", 2),
            _ => continue,
        };
        if rows.len() < min_occ {
            continue;
        }
        // Régularité : la plupart des écarts proches de l'écart médian.
        let regular = gaps.iter().filter(|x| ((**x - g).abs() as f64) <= g as f64 * 0.4).count();
        if (regular as f64) < gaps.len() as f64 * 0.6 {
            continue;
        }
        if cadence == "monthly" {
            let months: HashSet<(i32, u32)> = rows.iter().map(|r| (r.day.year(), r.day.month())).collect();
            if months.len() < 3 || rows.len() as f64 / months.len() as f64 > 1.5 {
                continue;
            }
        }
        let mut amounts: Vec<i64> = rows.iter().map(|r| r.amount).collect();
        amounts.sort_unstable();
        let median = amounts[amounts.len() / 2];
        let mean = amounts.iter().sum::<i64>() / amounts.len() as i64;
        let near = |tol: f64| amounts.iter().filter(|a| ((**a - median).abs() as f64) <= median as f64 * tol + 50.0).count();
        let fixed = near(0.05) as f64 >= amounts.len() as f64 * 0.8;
        // Montant variable : on garde si l'ordre de grandeur reste cohérent (courses hebdo, essence…).
        if !fixed && (cadence == "yearly" || (near(0.6) as f64) < amounts.len() as f64 * 0.6) {
            continue;
        }
        let lastr = rows.last().unwrap();
        let since = (last_data - lastr.day).num_days();
        let status = if since <= g + (g / 5).max(5) {
            "active"
        } else if since <= 2 * g + 5 {
            "late"
        } else {
            "stopped"
        };
        out.push(Recurring {
            name: merchant::display(&m),
            merchant: m,
            label: lastr.label.clone(),
            category_id: lastr.cat,
            kind: if debit { "expense" } else { "income" },
            cadence,
            fixed,
            amount_cents: lastr.amount,
            average_cents: mean,
            monthly_cents: (mean as f64 * 30.44 / g as f64).round() as i64,
            occurrences: rows.len(),
            first_day: rows[0].day.to_string(),
            last_day: lastr.day.to_string(),
            next_day: lastr.day.checked_add_signed(chrono::Duration::days(g)).map(|d| d.to_string()),
            interval_days: g,
            status,
        });
    }
    out.sort_by(|a, b| b.monthly_cents.cmp(&a.monthly_cents));
    Ok(out)
}

fn parse_day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()
}

// ---------------------------------------------------------------------------
// Modèle
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct Period {
    pub id: i64,
    pub name: String,
    pub months: i64,
    pub start_month: Option<String>,
    pub position: i64,
}

#[derive(Serialize, Clone)]
pub struct Line {
    pub id: i64,
    pub section: String,
    pub name: String,
    pub kind: String,
    pub category_id: Option<i64>,
    #[serde(rename = "match")]
    pub pattern: Option<String>,
    pub once_cents: Option<i64>,
    pub position: i64,
    /// period_id → montant prévu (centimes)
    pub amounts: HashMap<i64, i64>,
}

#[derive(Serialize)]
pub struct Budget {
    pub id: i64,
    pub name: String,
    pub notes: String,
    pub is_active: bool,
    pub created_at: String,
    pub periods: Vec<Period>,
    pub lines: Vec<Line>,
}

pub fn list(conn: &Connection) -> Result<Vec<Budget>> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM budgets ORDER BY is_active DESC, created_at DESC")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.into_iter().filter_map(|id| get(conn, id).transpose()).collect()
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Budget>> {
    let head = conn
        .query_row("SELECT name, notes, is_active, created_at FROM budgets WHERE id = ?1", [id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?, r.get::<_, String>(3)?))
        })
        .optional()?;
    let Some((name, notes, is_active, created_at)) = head else { return Ok(None) };
    let periods = conn
        .prepare("SELECT id, name, months, start_month, position FROM budget_periods WHERE budget_id = ?1 ORDER BY position, id")?
        .query_map([id], |r| {
            Ok(Period { id: r.get(0)?, name: r.get(1)?, months: r.get(2)?, start_month: r.get(3)?, position: r.get(4)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut lines = conn
        .prepare(
            "SELECT id, section, name, kind, category_id, match, once_cents, position FROM budget_lines
             WHERE budget_id = ?1 ORDER BY position, id",
        )?
        .query_map([id], |r| {
            Ok(Line {
                id: r.get(0)?,
                section: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                category_id: r.get(4)?,
                pattern: r.get(5)?,
                once_cents: r.get(6)?,
                position: r.get(7)?,
                amounts: HashMap::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut amounts: HashMap<i64, HashMap<i64, i64>> = HashMap::new();
    for row in conn
        .prepare(
            "SELECT a.line_id, a.period_id, a.amount_cents FROM budget_amounts a
             JOIN budget_lines l ON l.id = a.line_id WHERE l.budget_id = ?1",
        )?
        .query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?
    {
        let (l, p, a) = row?;
        amounts.entry(l).or_default().insert(p, a);
    }
    for l in lines.iter_mut() {
        l.amounts = amounts.remove(&l.id).unwrap_or_default();
    }
    Ok(Some(Budget { id, name, notes, is_active, created_at, periods, lines }))
}

// ---------------------------------------------------------------------------
// Import (fichier de départ, création depuis la détection, copie)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ImportBudget {
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub active: bool,
    pub periods: Vec<ImportPeriod>,
    pub lines: Vec<ImportLine>,
}

#[derive(Deserialize)]
pub struct ImportPeriod {
    pub name: String,
    #[serde(default = "one")]
    pub months: i64,
    pub start_month: Option<String>,
}
fn one() -> i64 {
    1
}

#[derive(Deserialize)]
pub struct ImportLine {
    #[serde(default)]
    pub section: String,
    pub name: String,
    pub kind: String,
    /// Nom de catégorie (résolu à l'import) ou identifiant.
    pub category: Option<String>,
    pub category_id: Option<i64>,
    #[serde(rename = "match")]
    pub pattern: Option<String>,
    /// En euros, alignés sur `periods` (null = vide).
    #[serde(default)]
    pub amounts: Vec<Option<f64>>,
    /// Montant annuel / ponctuel, en euros.
    pub once: Option<f64>,
}

fn cents(e: f64) -> i64 {
    (e * 100.0).round() as i64
}

pub fn import(conn: &mut Connection, b: &ImportBudget) -> Result<i64> {
    if b.name.trim().is_empty() {
        bail!("nom de budget vide");
    }
    let tx = conn.transaction()?;
    if b.active {
        tx.execute("UPDATE budgets SET is_active = 0", [])?;
    }
    tx.execute(
        "INSERT INTO budgets (name, notes, is_active, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![b.name.trim(), b.notes, b.active, db::now()],
    )?;
    let budget_id = tx.last_insert_rowid();
    let mut period_ids = Vec::new();
    for (i, p) in b.periods.iter().enumerate() {
        tx.execute(
            "INSERT INTO budget_periods (budget_id, name, months, start_month, position) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![budget_id, p.name, p.months.clamp(1, 24), p.start_month, i as i64],
        )?;
        period_ids.push(tx.last_insert_rowid());
    }
    for (i, l) in b.lines.iter().enumerate() {
        if !KINDS.contains(&l.kind.as_str()) {
            bail!("type de poste inconnu : {}", l.kind);
        }
        let cat: Option<i64> = match (&l.category, l.category_id) {
            (_, Some(id)) => Some(id),
            (Some(name), None) => tx
                .query_row("SELECT id FROM categories WHERE name = ?1 COLLATE NOCASE", [name], |r| r.get(0))
                .optional()?,
            _ => None,
        };
        tx.execute(
            "INSERT INTO budget_lines (budget_id, section, name, kind, category_id, match, once_cents, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                budget_id,
                l.section.trim(),
                l.name.trim(),
                l.kind,
                cat,
                l.pattern.as_deref().map(str::trim).filter(|p| !p.is_empty()),
                l.once.map(cents),
                i as i64
            ],
        )?;
        let line_id = tx.last_insert_rowid();
        for (p, a) in period_ids.iter().zip(&l.amounts) {
            if let Some(a) = a {
                tx.execute(
                    "INSERT INTO budget_amounts (line_id, period_id, amount_cents) VALUES (?1, ?2, ?3)",
                    params![line_id, p, cents(*a)],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(budget_id)
}

/// Fichier de départ facultatif (données personnelles, hors dépôt) : importé une seule fois.
pub fn import_seed(conn: &mut Connection, dir: &std::path::Path) -> Result<Option<String>> {
    let path = dir.join("budget-seed.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let seed: ImportBudget = serde_json::from_str(&raw)?;
    import(conn, &seed)?;
    std::fs::rename(&path, dir.join("budget-seed.imported.json"))?;
    Ok(Some(seed.name))
}

/// Budget construit à partir de l'existant : paiements récurrents actifs, puis dépenses
/// courantes par catégorie (moyenne des 3 derniers mois complets, arrondie à 5 €).
pub fn from_detected(conn: &mut Connection, name: &str) -> Result<i64> {
    let recurring = detect_recurring(conn)?;
    let salary_cat: Option<i64> =
        conn.query_row("SELECT id FROM categories WHERE name = 'Salaire'", [], |r| r.get(0)).optional()?;
    let mut lines = Vec::new();
    let mut covered: HashMap<Option<i64>, i64> = HashMap::new();
    for r in recurring.iter().filter(|r| r.status != "stopped") {
        let (section, kind) = match (r.kind, r.fixed) {
            ("income", _) if r.category_id.is_some() && r.category_id == salary_cat => ("Revenus", "salary"),
            ("income", _) => ("Revenus", "income"),
            (_, true) => ("Abonnements & prélèvements", "expense"),
            _ => ("Dépenses régulières", "expense"),
        };
        if kind == "expense" {
            *covered.entry(r.category_id).or_default() += r.monthly_cents;
        }
        lines.push(ImportLine {
            section: section.into(),
            name: r.name.clone(),
            kind: kind.into(),
            category: None,
            category_id: r.category_id,
            pattern: Some(r.merchant.clone()),
            amounts: vec![Some(r.monthly_cents as f64 / 100.0)],
            once: None,
        });
    }
    // Reste des dépenses par catégorie.
    let last_month: Option<String> = conn.query_row("SELECT MAX(month) FROM ledger", [], |r| r.get(0))?;
    if let Some(lm) = last_month {
        let rows: Vec<(Option<i64>, i64)> = conn
            .prepare(
                "SELECT category_id, -SUM(amount_cents) / 3 FROM ledger
                 WHERE kind = 'expense' AND month < ?1 AND month >= strftime('%Y-%m', date(?1 || '-01', '-3 months'))
                 GROUP BY category_id ORDER BY 2 DESC",
            )?
            .query_map([&lm], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (cat, avg) in rows {
            let rest = avg - covered.get(&cat).copied().unwrap_or(0);
            if rest < 1000 {
                continue;
            }
            let cat_name: Option<String> = match cat {
                Some(id) => conn.query_row("SELECT name FROM categories WHERE id = ?1", [id], |r| r.get(0)).optional()?,
                None => None,
            };
            lines.push(ImportLine {
                section: "Dépenses courantes".into(),
                name: cat_name.unwrap_or_else(|| "Non classé".into()),
                kind: "expense".into(),
                category: None,
                category_id: cat,
                pattern: None,
                amounts: vec![Some(((rest as f64 / 500.0).round() * 5.0).max(5.0))],
                once: None,
            });
        }
    }
    import(
        conn,
        &ImportBudget {
            name: name.into(),
            notes: "Créé à partir des paiements récurrents détectés et des dépenses des 3 derniers mois.".into(),
            active: false,
            periods: vec![ImportPeriod { name: "Mensuel".into(), months: 12, start_month: None }],
            lines,
        },
    )
}

pub fn duplicate(conn: &mut Connection, id: i64, name: &str) -> Result<i64> {
    let Some(b) = get(conn, id)? else { bail!("budget inconnu") };
    let periods: Vec<ImportPeriod> = b
        .periods
        .iter()
        .map(|p| ImportPeriod { name: p.name.clone(), months: p.months, start_month: p.start_month.clone() })
        .collect();
    let lines = b
        .lines
        .iter()
        .map(|l| ImportLine {
            section: l.section.clone(),
            name: l.name.clone(),
            kind: l.kind.clone(),
            category: None,
            category_id: l.category_id,
            pattern: l.pattern.clone(),
            amounts: b.periods.iter().map(|p| l.amounts.get(&p.id).map(|c| *c as f64 / 100.0)).collect(),
            once: l.once_cents.map(|c| c as f64 / 100.0),
        })
        .collect();
    import(conn, &ImportBudget { name: name.into(), notes: b.notes.clone(), active: false, periods, lines })
}

// ---------------------------------------------------------------------------
// Suivi dynamique
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct LineTrack {
    pub line_id: i64,
    pub planned_cents: Option<i64>,
    /// None : poste non relié (ni motif ni catégorie).
    pub actual_cents: Option<i64>,
    /// Moyenne des 3 mois précédents (ce qui est « détecté »).
    pub detected_cents: Option<i64>,
    pub count: usize,
    pub last_day: Option<String>,
}

#[derive(Serialize)]
pub struct CatTrack {
    pub category_id: Option<i64>,
    pub actual_cents: i64,
    pub detected_cents: i64,
    pub count: usize,
}

#[derive(Serialize)]
pub struct Tracking {
    pub month: String,
    pub months: Vec<String>,
    pub is_current_month: bool,
    pub period: Option<Period>,
    pub period_auto: bool,
    pub lines: Vec<LineTrack>,
    /// Dépenses du mois non rattachées à un poste.
    pub unbudgeted: Vec<CatTrack>,
    /// Revenus du mois non rattachés à un poste.
    pub unbudgeted_income: Vec<CatTrack>,
    /// Dépenses et revenus réels du mois (hors virements internes et épargne).
    pub actual_expense_cents: i64,
    pub actual_income_cents: i64,
    /// Paiements récurrents actifs non couverts par un poste.
    pub suggestions: Vec<Recurring>,
}

struct Tx {
    month: String,
    day: String,
    amount: i64,
    kind: String,
    category: Option<i64>,
    text: String,
}

fn ym(s: &str) -> Option<(i32, u32)> {
    let (y, m) = s.get(..7)?.split_once('-')?;
    Some((y.parse().ok()?, m.parse().ok()?))
}
fn add_months((y, m): (i32, u32), n: i32) -> String {
    let idx = y * 12 + m as i32 - 1 + n;
    format!("{:04}-{:02}", idx.div_euclid(12), idx.rem_euclid(12) + 1)
}

/// La période qui couvre `month` (si des débuts sont renseignés), sinon la première.
fn resolve_period(periods: &[Period], month: &str) -> Option<Period> {
    let m = ym(month)?;
    periods
        .iter()
        .find(|p| {
            p.start_month.as_deref().and_then(ym).is_some_and(|s| {
                let start = s.0 * 12 + s.1 as i32;
                let cur = m.0 * 12 + m.1 as i32;
                cur >= start && cur < start + p.months as i32
            })
        })
        .or(periods.first())
        .cloned()
}

/// Un poste « attrape » une opération : bon sens (dépense = débit), puis motif ou catégorie.
fn line_matches(l: &Line, t: &Tx) -> bool {
    let debit = t.amount < 0;
    let sign_ok = match l.kind.as_str() {
        "income" | "salary" => !debit,
        _ => debit,
    };
    if !sign_ok {
        return false;
    }
    match (&l.pattern, l.category_id) {
        (Some(p), _) if !p.trim().is_empty() => t.text.contains(&p.to_uppercase()),
        (_, Some(c)) => t.category == Some(c),
        _ => false,
    }
}

pub fn tracking(conn: &Connection, budget_id: i64, month: Option<&str>, period_id: Option<i64>) -> Result<Tracking> {
    let Some(b) = get(conn, budget_id)? else { bail!("budget inconnu") };
    let months: Vec<String> = conn
        .prepare("SELECT DISTINCT month FROM ledger ORDER BY month")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let today = chrono::Local::now().date_naive();
    let current = format!("{:04}-{:02}", today.year(), today.month());
    let month = month
        .filter(|m| ym(m).is_some())
        .map(str::to_string)
        .or_else(|| months.last().cloned())
        .unwrap_or_else(|| current.clone());
    let (period, period_auto) = match period_id.and_then(|id| b.periods.iter().find(|p| p.id == id)) {
        Some(p) => (Some(p.clone()), false),
        None => (resolve_period(&b.periods, &month), true),
    };
    let m = ym(&month).unwrap_or((today.year(), today.month()));
    let from = add_months(m, -3);

    let txs: Vec<Tx> = conn
        .prepare(
            "SELECT month, day, amount_cents, kind, category_id,
                    upper(label || ' ' || COALESCE(counterparty, '') || ' ' || COALESCE(merchant, ''))
             FROM ledger WHERE month BETWEEN ?1 AND ?2 ORDER BY day",
        )?
        .query_map(params![from, month], |r| {
            Ok(Tx { month: r.get(0)?, day: r.get(1)?, amount: r.get(2)?, kind: r.get(3)?, category: r.get(4)?, text: r.get(5)? })
        })?
        .collect::<Result<_, _>>()?;

    // Ordre d'attribution : postes à motif (le plus long d'abord), puis postes par catégorie.
    let mut order: Vec<&Line> = b.lines.iter().filter(|l| l.pattern.as_deref().is_some_and(|p| !p.trim().is_empty())).collect();
    order.sort_by_key(|l| std::cmp::Reverse(l.pattern.as_deref().map_or(0, str::len)));
    order.extend(b.lines.iter().filter(|l| l.pattern.as_deref().is_none_or(|p| p.trim().is_empty()) && l.category_id.is_some()));

    #[derive(Default)]
    struct Acc {
        cur: i64,
        past: i64,
        count: usize,
        last_day: Option<String>,
    }
    let mut per_line: HashMap<i64, Acc> = HashMap::new();
    let mut unb: HashMap<(bool, Option<i64>), Acc> = HashMap::new();
    let (mut actual_expense, mut actual_income) = (0i64, 0i64);
    for t in &txs {
        let is_cur = t.month == month;
        if is_cur {
            match t.kind.as_str() {
                "expense" => actual_expense -= t.amount,
                "income" => actual_income += t.amount,
                _ => {}
            }
        }
        let value = t.amount.abs();
        if let Some(l) = order.iter().find(|l| line_matches(l, t)) {
            let a = per_line.entry(l.id).or_default();
            if is_cur {
                a.cur += value;
                a.count += 1;
                a.last_day = Some(t.day.clone());
            } else {
                a.past += value;
            }
        } else if t.kind == "expense" || t.kind == "income" {
            let a = unb.entry((t.kind == "income", t.category)).or_default();
            // Hors budget : montant net (un remboursement réduit la dépense de sa catégorie).
            let signed = if t.kind == "income" { t.amount } else { -t.amount };
            if is_cur {
                a.cur += signed;
                a.count += 1;
            } else {
                a.past += signed;
            }
        }
    }

    let lines = b
        .lines
        .iter()
        .map(|l| {
            let tracked = l.pattern.as_deref().is_some_and(|p| !p.trim().is_empty()) || l.category_id.is_some();
            let acc = per_line.get(&l.id);
            LineTrack {
                line_id: l.id,
                planned_cents: period.as_ref().and_then(|p| l.amounts.get(&p.id).copied()),
                actual_cents: tracked.then(|| acc.map_or(0, |a| a.cur)),
                detected_cents: tracked.then(|| acc.map_or(0, |a| a.past) / 3),
                count: acc.map_or(0, |a| a.count),
                last_day: acc.and_then(|a| a.last_day.clone()),
            }
        })
        .collect();

    let to_cat = |income: bool| -> Vec<CatTrack> {
        let mut v: Vec<CatTrack> = unb
            .iter()
            .filter(|((inc, _), a)| *inc == income && (a.cur > 0 || a.past > 0))
            .map(|((_, cat), a)| CatTrack { category_id: *cat, actual_cents: a.cur, detected_cents: a.past / 3, count: a.count })
            .collect();
        v.sort_by(|a, b| b.actual_cents.cmp(&a.actual_cents).then(b.detected_cents.cmp(&a.detected_cents)));
        v
    };

    // Récurrents actifs qu'aucun poste n'attrape.
    let suggestions = detect_recurring(conn)?
        .into_iter()
        .filter(|r| r.status != "stopped" && r.monthly_cents >= 100)
        .filter(|r| {
            let probe = Tx {
                month: String::new(),
                day: String::new(),
                amount: if r.kind == "expense" { -1 } else { 1 },
                kind: r.kind.into(),
                category: r.category_id,
                text: format!("{} {}", r.label, r.merchant).to_uppercase(),
            };
            !b.lines.iter().any(|l| line_matches(l, &probe))
        })
        .collect();

    Ok(Tracking {
        is_current_month: month == current,
        month,
        months,
        period,
        period_auto,
        lines,
        unbudgeted: to_cat(false),
        unbudgeted_income: to_cat(true),
        actual_expense_cents: actual_expense,
        actual_income_cents: actual_income,
        suggestions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(kind: &str, pattern: Option<&str>, cat: Option<i64>) -> Line {
        Line {
            id: 1,
            section: String::new(),
            name: String::new(),
            kind: kind.into(),
            category_id: cat,
            pattern: pattern.map(Into::into),
            once_cents: None,
            position: 0,
            amounts: HashMap::new(),
        }
    }
    fn tx(amount: i64, cat: Option<i64>, text: &str) -> Tx {
        Tx { month: "2026-11".into(), day: "2026-11-02".into(), amount, kind: "expense".into(), category: cat, text: text.into() }
    }

    #[test]
    fn matching() {
        // Le motif prime et respecte le sens : « OVH » dépense ne prend pas le salaire versé par OVH.
        let ovh = line("expense", Some("ovh"), None);
        assert!(line_matches(&ovh, &tx(-2000, Some(3), "PAYPAL *OVH")));
        assert!(!line_matches(&ovh, &tx(135492, Some(26), "E OVH")));
        let salary = line("salary", None, Some(26));
        assert!(line_matches(&salary, &tx(135492, Some(26), "E OVH")));
        let food = line("expense", None, Some(1));
        assert!(line_matches(&food, &tx(-3037, Some(1), "LIDL")));
        assert!(!line_matches(&food, &tx(-3037, Some(2), "LIDL")));
    }

    #[test]
    fn periods() {
        let ps = vec![
            Period { id: 1, name: "A".into(), months: 5, start_month: Some("2026-09".into()), position: 0 },
            Period { id: 2, name: "B".into(), months: 4, start_month: Some("2027-02".into()), position: 1 },
        ];
        assert_eq!(resolve_period(&ps, "2026-11").unwrap().id, 1);
        assert_eq!(resolve_period(&ps, "2027-03").unwrap().id, 2);
        assert_eq!(resolve_period(&ps, "2027-09").unwrap().id, 1); // hors plage : la première
        assert_eq!(add_months((2026, 1), -3), "2025-10");
    }
}
