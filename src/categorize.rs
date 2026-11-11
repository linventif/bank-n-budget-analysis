//! Catégorisation, par ordre de priorité :
//! 1. choix manuel (`user`) : jamais modifié automatiquement ;
//! 2. règles (`rule`) : « le libellé contient … » ;
//! 3. mémoire (`memory`) : même marchand qu'une opération classée à la main ;
//! 4. virements internes (`transfer`) : à son propre nom, paires débit/crédit entre ses comptes, coffres Revolut ;
//! 5. IA locale (`ai`) pour le reste.

use crate::{AppState, ai, merchant};
use anyhow::{Result, bail};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock};

/// Recalcule la clé marchand des opérations qui n'en ont pas encore.
pub fn backfill_merchants(conn: &Connection) -> Result<usize> {
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, label FROM transactions WHERE merchant IS NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare("UPDATE transactions SET merchant = ?1 WHERE id = ?2")?;
    for (id, label) in &rows {
        stmt.execute(params![merchant::key(label), id])?;
    }
    Ok(rows.len())
}

#[derive(Default, Serialize, Debug)]
pub struct Stats {
    pub rule: usize,
    pub memory: usize,
    pub transfer: usize,
    pub remaining: usize,
}

const OPEN: &str = "(category_source IS NULL OR category_source = 'ai')";

static SAVINGS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(to|from|vers|depuis)\s+.*(savings|investment|invest|vault|coffre|épargne|epargne|pocket|livret)").unwrap()
});
/// Poches et changes de devises Revolut : « To EUR », « Exchanged to EUR ».
static POCKET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(exchanged\s+)?(to|from)\s+(EUR|USD|GBP|CHF|PLN|SEK|NOK|DKK|CZK|HUF|RON|BGN|JPY|CAD|AUD|NZD|SGD|HKD|TRY|MAD)\b")
        .unwrap()
});

/// Étapes 2 à 4 (rapides, déterministes). Les résultats précédents de ces étapes sont recalculés
/// pour tenir compte des règles ou corrections ajoutées / supprimées.
pub fn apply_deterministic(conn: &mut Connection) -> Result<Stats> {
    let tx = conn.transaction()?;
    let mut st = Stats::default();
    tx.execute(
        "UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL
         WHERE category_source IN ('rule', 'memory', 'transfer')",
        [],
    )?;

    // --- Règles (motif le plus long d'abord : le plus spécifique gagne) ---
    let rules: Vec<(String, i64)> = tx
        .prepare("SELECT upper(pattern), category_id FROM rules ORDER BY length(pattern) DESC, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if !rules.is_empty() {
        let open: Vec<(i64, String)> = tx
            .prepare(&format!(
                "SELECT id, upper(label || ' ' || COALESCE(counterparty, '') || ' ' || COALESCE(merchant, ''))
                 FROM transactions WHERE {OPEN}"
            ))?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut upd = tx.prepare(
            "UPDATE transactions SET category_id = ?1, category_source = 'rule', category_confidence = 1 WHERE id = ?2",
        )?;
        for (id, text) in &open {
            if let Some((_, cat)) = rules.iter().find(|(p, _)| !p.is_empty() && text.contains(p.as_str())) {
                upd.execute(params![cat, id])?;
                st.rule += 1;
            }
        }
    }

    // --- Mémoire : catégorie majoritaire choisie à la main pour (marchand, sens) ---
    let memory: Vec<(String, bool, i64)> = tx
        .prepare(
            "SELECT merchant, debit, category_id FROM (
                SELECT merchant, amount_cents < 0 AS debit, category_id,
                       ROW_NUMBER() OVER (PARTITION BY merchant, amount_cents < 0 ORDER BY COUNT(*) DESC, MAX(day) DESC) AS rk
                FROM transactions
                WHERE category_source = 'user' AND category_id IS NOT NULL AND merchant IS NOT NULL
                GROUP BY merchant, amount_cents < 0, category_id
             ) WHERE rk = 1",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    {
        let mut upd = tx.prepare(&format!(
            "UPDATE transactions SET category_id = ?1, category_source = 'memory', category_confidence = 1
             WHERE merchant = ?2 AND (amount_cents < 0) = ?3 AND {OPEN}"
        ))?;
        for (m, debit, cat) in &memory {
            st.memory += upd.execute(params![cat, m, debit])?;
        }
    }

    // --- Virements internes et épargne ---
    let role = |r: &str| -> rusqlite::Result<Option<i64>> {
        tx.query_row("SELECT id FROM categories WHERE role = ?1", [r], |row| row.get(0)).optional()
    };
    let internal = role("internal")?;
    let savings = role("savings")?;

    if internal.is_some() || savings.is_some() {
        let holders: Vec<String> = tx
            .prepare("SELECT DISTINCT name FROM accounts WHERE name IS NOT NULL")?
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|n| n.ok().and_then(|n| merchant::holder_name(&n)))
            .flat_map(|n| merchant::holder_keys(&n))
            .collect();

        struct Open {
            id: i64,
            account: String,
            day: Option<String>,
            amount: i64,
            label: String,
            counterparty: Option<String>,
        }
        let open: Vec<Open> = tx
            .prepare(&format!(
                "SELECT id, account_hash, day, amount_cents, label, counterparty FROM transactions
                 WHERE {OPEN} AND amount_cents <> 0"
            ))?
            .query_map([], |r| {
                Ok(Open {
                    id: r.get(0)?,
                    account: r.get(1)?,
                    day: r.get(2)?,
                    amount: r.get(3)?,
                    label: r.get(4)?,
                    counterparty: r.get(5)?,
                })
            })?
            .collect::<Result<_, _>>()?;

        let mut assigned: HashMap<i64, i64> = HashMap::new();
        for o in &open {
            let text = format!("{} {}", o.label, o.counterparty.as_deref().unwrap_or(""));
            if let Some(s) = savings.filter(|_| SAVINGS.is_match(o.label.trim())) {
                assigned.insert(o.id, s);
            } else if let Some(i) = internal {
                let squashed = merchant::squash(&text);
                if POCKET.is_match(o.label.trim()) || holders.iter().any(|h| squashed.contains(h.as_str())) {
                    assigned.insert(o.id, i);
                }
            }
        }

        // Paires : même montant, sens opposé, comptes différents, à 4 jours près.
        if let Some(i) = internal {
            let mut used: std::collections::HashSet<i64> = assigned.keys().copied().collect();
            for a in open.iter().filter(|o| o.amount < 0) {
                if used.contains(&a.id) {
                    continue;
                }
                let Some(da) = a.day.as_deref().and_then(parse_day) else { continue };
                let partner = open.iter().find(|b| {
                    b.amount == -a.amount
                        && b.account != a.account
                        && !used.contains(&b.id)
                        && b.day.as_deref().and_then(parse_day).is_some_and(|db| (db - da).num_days().abs() <= 4)
                });
                if let Some(b) = partner {
                    used.insert(a.id);
                    used.insert(b.id);
                    assigned.insert(a.id, i);
                    assigned.insert(b.id, i);
                }
            }
        }

        let mut upd = tx.prepare(
            "UPDATE transactions SET category_id = ?1, category_source = 'transfer', category_confidence = 1 WHERE id = ?2",
        )?;
        for (id, cat) in &assigned {
            upd.execute(params![cat, id])?;
        }
        st.transfer = assigned.len();
    }

    st.remaining = tx.query_row(
        "SELECT COUNT(*) FROM transactions WHERE category_id IS NULL AND amount_cents <> 0",
        [],
        |r| r.get::<_, i64>(0),
    )? as usize;
    tx.commit()?;
    Ok(st)
}

fn parse_day(s: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

// ---------------------------------------------------------------------------
// IA
// ---------------------------------------------------------------------------

#[derive(Default, Clone, Serialize)]
pub struct AiProgress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub classified: usize,
    pub message: Option<String>,
    pub finished_at: Option<String>,
}

/// Lance la classification IA en tâche de fond (sauf si déjà en cours).
pub fn spawn_ai(state: Arc<AppState>, reclassify: bool) {
    if state.ai.is_none() || state.classifying.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        *state.ai_progress.lock().unwrap() = AiProgress { running: true, ..Default::default() };
        let result = run_ai(&state, reclassify).await;
        let mut p = state.ai_progress.lock().unwrap();
        p.running = false;
        p.finished_at = Some(crate::db::now());
        p.message = Some(match result {
            Ok(msg) => msg,
            Err(e) => format!("Échec de la classification IA : {e:#}"),
        });
        tracing::info!("{}", p.message.as_deref().unwrap_or(""));
        drop(p);
        state.classifying.store(false, Ordering::SeqCst);
    });
}

struct Group {
    merchant: String,
    debit: bool,
    count: usize,
    label: String,
    counterparty: Option<String>,
    avg_cents: f64,
    code: Option<String>,
}

struct Cat {
    id: i64,
    name: String,
    kind: String,
    description: String,
}

async fn run_ai(state: &AppState, reclassify: bool) -> Result<String> {
    let Some(client) = state.ai.as_ref() else { bail!("IA désactivée") };
    let health = client.health().await;
    if !health.reachable {
        bail!("Ollama ne répond pas ({})", state.cfg.ai.url);
    }
    if !health.model_installed {
        bail!("le modèle {} n'est pas installé : ollama pull {}", client.model(), client.model());
    }

    let (cats, examples, groups) = {
        let conn = state.db.lock().unwrap();
        if reclassify {
            conn.execute(
                "UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL
                 WHERE category_source = 'ai'",
                [],
            )?;
        }
        let cats: Vec<Cat> = conn
            .prepare("SELECT id, name, kind, description FROM categories ORDER BY position, id")?
            .query_map([], |r| Ok(Cat { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, description: r.get(3)? }))?
            .collect::<Result<_, _>>()?;
        let examples: Vec<(String, String)> = conn
            .prepare(
                "SELECT t.merchant, c.name FROM transactions t JOIN categories c ON c.id = t.category_id
                 WHERE t.category_source IN ('user', 'rule') AND t.merchant IS NOT NULL
                 GROUP BY t.merchant ORDER BY MAX(t.day) DESC LIMIT 40",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let groups: Vec<Group> = conn
            .prepare(
                "SELECT merchant, amount_cents < 0, COUNT(*), MAX(label), MAX(counterparty), AVG(amount_cents),
                        MAX(json_extract(raw, '$.bank_transaction_code.code'))
                 FROM transactions
                 WHERE category_id IS NULL AND amount_cents <> 0 AND merchant IS NOT NULL
                 GROUP BY merchant, amount_cents < 0
                 ORDER BY COUNT(*) DESC",
            )?
            .query_map([], |r| {
                Ok(Group {
                    merchant: r.get(0)?,
                    debit: r.get(1)?,
                    count: r.get::<_, i64>(2)? as usize,
                    label: r.get(3)?,
                    counterparty: r.get(4)?,
                    avg_cents: r.get(5)?,
                    code: r.get(6)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        (cats, examples, groups)
    };
    if groups.is_empty() {
        return Ok("Rien à classer : toutes les opérations ont une catégorie".into());
    }

    let batches: Vec<(bool, Vec<&Group>)> = [true, false]
        .into_iter()
        .flat_map(|debit| {
            let g: Vec<&Group> = groups.iter().filter(|g| g.debit == debit).collect();
            g.chunks(client.batch_size()).map(|c| (debit, c.to_vec())).collect::<Vec<_>>()
        })
        .collect();
    {
        let mut p = state.ai_progress.lock().unwrap();
        p.total = groups.len();
        p.message = Some(format!("{} marchands à classer avec {}", groups.len(), client.model()));
    }

    let mut classified = 0usize;
    let mut failures = 0usize;
    for (debit, batch) in &batches {
        let allowed: Vec<&Cat> = cats
            .iter()
            .filter(|c| c.kind == "transfer" || c.kind == if *debit { "expense" } else { "income" })
            .collect();
        let choices: Vec<ai::Choice> =
            allowed.iter().map(|c| ai::Choice { name: &c.name, description: &c.description }).collect();
        let items: Vec<ai::Item> = batch
            .iter()
            .enumerate()
            .map(|(i, g)| ai::Item {
                i,
                libelle: g.label.clone(),
                contrepartie: g.counterparty.clone().filter(|c| !g.label.to_uppercase().contains(&c.to_uppercase())),
                montant: (g.avg_cents / 100.0 * 100.0).round() / 100.0,
                kind: g.code.clone(),
                nb: g.count,
            })
            .collect();
        let direction = if *debit { "débits : argent qui sort" } else { "crédits : argent qui entre" };

        let started = std::time::Instant::now();
        match client.classify(&choices, &examples, &items, direction).await {
            Ok(answers) => {
                let conn = state.db.lock().unwrap();
                let mut upd = conn.prepare(
                    "UPDATE transactions SET category_id = ?1, category_source = 'ai', category_confidence = ?2
                     WHERE merchant = ?3 AND (amount_cents < 0) = ?4 AND category_id IS NULL",
                )?;
                for a in answers {
                    let (Some(g), Some(cat)) = (
                        batch.get(a.i),
                        allowed.iter().find(|c| c.name.eq_ignore_ascii_case(a.categorie.trim())),
                    ) else {
                        continue;
                    };
                    let conf = a.confiance.unwrap_or(0.5).clamp(0.0, 1.0);
                    if upd.execute(params![cat.id, conf, g.merchant, g.debit])? > 0 {
                        classified += 1;
                    }
                }
            }
            Err(e) => {
                failures += 1;
                tracing::warn!("lot IA en échec : {e:#}");
            }
        }
        tracing::info!("lot IA de {} marchands en {:.1}s", batch.len(), started.elapsed().as_secs_f32());
        let mut p = state.ai_progress.lock().unwrap();
        p.done += batch.len();
        p.classified = classified;
    }

    let mut msg = format!("IA : {classified} marchand(s) classé(s) sur {}", groups.len());
    if failures > 0 {
        msg += &format!(" ({failures} lot(s) en échec, voir les logs)");
    }
    Ok(msg)
}
