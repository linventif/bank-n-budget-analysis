//! Enregistrement des sessions et synchronisation des soldes / transactions.

use crate::AppState;
use crate::db;
use crate::eb::{self, ApiError, Transaction};
use anyhow::{Context, Result, bail};
use chrono::{Duration, NaiveDate};
use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

/// Jours re-téléchargés avant la dernière opération connue (les banques comptabilisent parfois en retard).
const OVERLAP_DAYS: i64 = 10;
/// Garde-fou contre une pagination qui ne s'arrêterait pas.
const MAX_PAGES: usize = 500;

/// Enregistre une session fraîchement autorisée et ses comptes. Renvoie le nombre de comptes.
pub fn store_session(conn: &mut Connection, s: &eb::Session) -> Result<usize> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO sessions (session_id, aspsp_name, aspsp_country, valid_until, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'AUTHORIZED', ?5)",
        params![s.session_id, s.aspsp.name, s.aspsp.country, s.access.valid_until, db::now()],
    )?;
    let mut n = 0;
    for raw in &s.accounts {
        let a: eb::Account = serde_json::from_value(raw.clone()).context("compte illisible")?;
        tx.execute(
            "INSERT INTO accounts (hash, uid, session_id, aspsp_name, iban, name, details, product, currency, cash_account_type, raw)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT (hash) DO UPDATE SET
                uid = excluded.uid, session_id = excluded.session_id, aspsp_name = excluded.aspsp_name,
                iban = excluded.iban, name = excluded.name, details = excluded.details, product = excluded.product,
                currency = excluded.currency, cash_account_type = excluded.cash_account_type,
                raw = excluded.raw, last_error = NULL",
            params![
                a.identification_hash,
                a.uid,
                s.session_id,
                s.aspsp.name,
                a.account_id.as_ref().and_then(|i| i.iban.clone()),
                a.name,
                a.details,
                a.product,
                a.currency,
                a.cash_account_type,
                raw.to_string(),
            ],
        )?;
        n += 1;
    }
    tx.commit()?;
    Ok(n)
}

/// Lance une synchro en tâche de fond, sauf si une est déjà en cours.
pub fn spawn(state: Arc<AppState>) {
    if state.syncing.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let msg = match run(&state).await {
            Ok(m) => m,
            Err(e) => format!("Échec de la synchronisation : {e:#}"),
        };
        tracing::info!("{msg}");
        // Catégorisation des nouvelles opérations : règles / mémoire / virements, puis IA en tâche de fond.
        let cat = crate::categorize::apply_deterministic(&mut state.db.lock().unwrap());
        match cat {
            Ok(st) => tracing::info!(?st, "catégorisation automatique"),
            Err(e) => tracing::warn!("catégorisation automatique en échec : {e:#}"),
        }
        *state.last_sync_message.lock().unwrap() = Some(msg);
        state.syncing.store(false, Ordering::SeqCst);
        if state.cfg.ai.enabled {
            crate::categorize::spawn_ai(state.clone(), false);
        }
    });
}

struct Target {
    hash: String,
    uid: String,
    session_id: String,
    last_booking: Option<String>,
}

async fn run(state: &AppState) -> Result<String> {
    let Some(client) = state.eb.as_ref() else { bail!("Enable Banking n'est pas configuré") };

    let targets: Vec<Target> = {
        let conn = state.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT a.hash, a.uid, a.session_id,
                    (SELECT MAX(booking_date) FROM transactions t WHERE t.account_hash = a.hash AND t.status = 'BOOK')
             FROM accounts a JOIN sessions s ON s.session_id = a.session_id
             WHERE a.uid IS NOT NULL AND s.status = 'AUTHORIZED' AND s.valid_until > ?1",
        )?;
        stmt.query_map([db::now()], |r| {
            Ok(Target { hash: r.get(0)?, uid: r.get(1)?, session_id: r.get(2)?, last_booking: r.get(3)? })
        })?
        .collect::<Result<_, _>>()?
    };
    if targets.is_empty() {
        bail!("aucun compte avec une autorisation valide : connecte (ou reconnecte) ta banque");
    }

    let (mut ok, mut new_tx, mut failed) = (0, 0, 0);
    for t in &targets {
        match sync_account(state, client, t).await {
            Ok(n) => {
                ok += 1;
                new_tx += n;
            }
            Err(e) => {
                failed += 1;
                tracing::warn!(account = %t.hash, "synchro échouée : {e:#}");
                let conn = state.db.lock().unwrap();
                conn.execute("UPDATE accounts SET last_error = ?1 WHERE hash = ?2", params![format!("{e:#}"), t.hash])?;
                if e.downcast_ref::<ApiError>().is_some_and(ApiError::is_session_dead) {
                    conn.execute("UPDATE sessions SET status = 'EXPIRED' WHERE session_id = ?1", [&t.session_id])?;
                }
            }
        }
    }
    let mut msg = format!("Synchronisation terminée : {ok} compte(s), {new_tx} nouvelle(s) opération(s)");
    if failed > 0 {
        msg += &format!(", {failed} compte(s) en erreur");
    }
    Ok(msg)
}

/// Renvoie le nombre de nouvelles transactions insérées.
async fn sync_account(state: &AppState, client: &eb::Client, t: &Target) -> Result<usize> {
    let balances = client.balances(&t.uid).await.context("soldes")?;

    let date_from = t
        .last_booking
        .as_deref()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .map(|d| d - Duration::days(OVERLAP_DAYS));
    let mut raws: Vec<Value> = Vec::new();
    let mut key: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = client.transactions_page(&t.uid, date_from, key.as_deref()).await.context("transactions")?;
        raws.extend(page.transactions);
        // Une page vide peut quand même porter une clé : on continue jusqu'à `null`.
        match page.continuation_key {
            Some(k) if !k.is_empty() => key = Some(k),
            _ => break,
        }
    }

    // Tout est téléchargé : on écrit en une seule transaction SQLite.
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;

    if let Some(b) = pick_balance(&balances) {
        tx.execute(
            "UPDATE accounts SET balance_cents = ?1, balance_type = ?2, balance_date = ?3 WHERE hash = ?4",
            params![to_cents(&b.balance_amount.amount)?, b.balance_type, b.reference_date, t.hash],
        )?;
    }

    // Les opérations en attente changent de forme une fois comptabilisées : on les remplace à chaque fois.
    tx.execute("DELETE FROM transactions WHERE account_hash = ?1 AND status <> 'BOOK'", [&t.hash])?;

    let now = db::now();
    let mut seen: HashMap<String, u32> = HashMap::new();
    for raw in &raws {
        let tr: Transaction = serde_json::from_value(raw.clone()).context("transaction illisible")?;
        let n = norm(&tr)?;
        // Deux opérations identiques le même jour (2 cafés à 2,50 €) : on les numérote.
        let count = seen.entry(n.fingerprint.clone()).or_insert(0);
        let fingerprint = if *count == 0 { n.fingerprint.clone() } else { format!("{}#{count}", n.fingerprint) };
        *count += 1;

        tx.execute(
            "INSERT INTO transactions (account_hash, fingerprint, status, booking_date, value_date, transaction_date,
                                       amount_cents, currency, counterparty, label, mcc, raw, first_seen, merchant)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT (account_hash, fingerprint) DO UPDATE SET
                status = excluded.status, booking_date = excluded.booking_date, value_date = excluded.value_date,
                transaction_date = excluded.transaction_date, amount_cents = excluded.amount_cents,
                counterparty = excluded.counterparty, label = excluded.label, mcc = excluded.mcc, raw = excluded.raw,
                merchant = excluded.merchant",
            params![
                t.hash,
                fingerprint,
                tr.status,
                tr.booking_date,
                tr.value_date,
                tr.transaction_date,
                n.amount_cents,
                tr.transaction_amount.currency,
                n.counterparty,
                n.label,
                tr.merchant_category_code,
                raw.to_string(),
                now,
                crate::merchant::key(&n.label),
            ],
        )?;
    }
    // Nouveautés = opérations comptabilisées vues pour la première fois lors de cette synchro
    // (first_seen n'est jamais mis à jour en cas de conflit).
    let inserted = tx.query_row(
        "SELECT COUNT(*) FROM transactions WHERE account_hash = ?1 AND first_seen = ?2 AND status = 'BOOK'",
        params![t.hash, now],
        |r| r.get::<_, i64>(0),
    )? as usize;

    tx.execute(
        "UPDATE accounts SET last_sync = ?1, last_error = NULL WHERE hash = ?2",
        params![now, t.hash],
    )?;
    tx.commit()?;
    Ok(inserted)
}

fn pick_balance(balances: &[eb::Balance]) -> Option<&eb::Balance> {
    const PREFERRED: &[&str] = &["CLBD", "ITBD", "XPCD", "ITAV", "CLAV", "OPBD", "OTHR"];
    PREFERRED
        .iter()
        .find_map(|p| balances.iter().find(|b| b.balance_type == *p))
        .or(balances.first())
}

struct Normalized {
    fingerprint: String,
    amount_cents: i64,
    counterparty: Option<String>,
    label: String,
}

fn norm(t: &Transaction) -> Result<Normalized> {
    let abs = to_cents(&t.transaction_amount.amount)?.abs();
    let debit = t.credit_debit_indicator == "DBIT";
    let amount_cents = if debit { -abs } else { abs };

    let party = if debit { &t.creditor } else { &t.debtor };
    let counterparty = party.as_ref().and_then(|p| p.name.clone()).filter(|s| !s.trim().is_empty());

    let remittance = t.remittance_information.as_deref().unwrap_or_default().join(" ");
    let label = [
        Some(remittance.trim().to_string()),
        t.note.clone(),
        counterparty.clone(),
        t.bank_transaction_code.as_ref().and_then(|c| c.description.clone()),
    ]
    .into_iter()
    .flatten()
    .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
    .find(|s| !s.is_empty())
    .unwrap_or_else(|| "(sans libellé)".into());

    let base = if let Some(id) = t.transaction_id.as_deref().filter(|s| !s.is_empty()) {
        format!("tid:{id}")
    } else if let Some(r) = t.entry_reference.as_deref().filter(|s| !s.is_empty()) {
        format!("ref:{r}")
    } else {
        let mut h = Sha256::new();
        for part in [
            t.booking_date.as_deref().unwrap_or(""),
            t.value_date.as_deref().unwrap_or(""),
            t.transaction_date.as_deref().unwrap_or(""),
            &amount_cents.to_string(),
            &t.transaction_amount.currency,
            &remittance,
            t.creditor.as_ref().and_then(|p| p.name.as_deref()).unwrap_or(""),
            t.debtor.as_ref().and_then(|p| p.name.as_deref()).unwrap_or(""),
        ] {
            h.update(part.as_bytes());
            h.update([0u8]);
        }
        let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        format!("h:{digest}")
    };
    // Une opération en attente ne doit jamais écraser sa future version comptabilisée.
    let fingerprint = if t.status == "BOOK" { base } else { format!("pending:{base}") };

    Ok(Normalized { fingerprint, amount_cents, counterparty, label })
}

/// "1234.5" -> 123450 ; arrondi au centime le plus proche.
pub fn to_cents(s: &str) -> Result<i64> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if (int.is_empty() && frac.is_empty())
        || !int.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        bail!("montant invalide : {s:?}");
    }
    let int: i64 = if int.is_empty() { 0 } else { int.parse()? };
    let mut cents_str: String = frac.chars().take(2).collect();
    while cents_str.len() < 2 {
        cents_str.push('0');
    }
    let mut v = int * 100 + cents_str.parse::<i64>()?;
    if frac.as_bytes().get(2).is_some_and(|d| *d >= b'5') {
        v += 1;
    }
    Ok(if neg { -v } else { v })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cents() {
        assert_eq!(to_cents("1.23").unwrap(), 123);
        assert_eq!(to_cents("1234.5").unwrap(), 123450);
        assert_eq!(to_cents("12").unwrap(), 1200);
        assert_eq!(to_cents("-0.07").unwrap(), -7);
        assert_eq!(to_cents("0.125").unwrap(), 13);
        assert_eq!(to_cents(".5").unwrap(), 50);
        assert!(to_cents("1,23").is_err());
        assert!(to_cents("").is_err());
    }

    fn tx(json: serde_json::Value) -> Transaction {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn normalisation() {
        let t = tx(serde_json::json!({
            "transaction_amount": {"currency": "EUR", "amount": "42.10"},
            "credit_debit_indicator": "DBIT",
            "status": "BOOK",
            "booking_date": "2026-11-02",
            "creditor": {"name": "CARREFOUR"},
            "remittance_information": ["CB CARREFOUR  02/11", "PARIS"]
        }));
        let n = norm(&t).unwrap();
        assert_eq!(n.amount_cents, -4210);
        assert_eq!(n.counterparty.as_deref(), Some("CARREFOUR"));
        assert_eq!(n.label, "CB CARREFOUR 02/11 PARIS");
        assert!(n.fingerprint.starts_with("h:"));

        let p = tx(serde_json::json!({
            "transaction_amount": {"currency": "EUR", "amount": 5},
            "credit_debit_indicator": "CRDT",
            "status": "PDNG",
            "entry_reference": "ABC",
            "remittance_information": null
        }));
        let n = norm(&p).unwrap();
        assert_eq!(n.amount_cents, 500);
        assert_eq!(n.fingerprint, "pending:ref:ABC");
        assert_eq!(n.label, "(sans libellé)");
    }
}
