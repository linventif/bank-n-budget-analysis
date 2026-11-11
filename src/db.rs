use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// Migrations appliquées dans l'ordre ; `PRAGMA user_version` = nombre déjà appliqué.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE pending_auth (
    state         TEXT PRIMARY KEY,
    aspsp_name    TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
    session_id    TEXT PRIMARY KEY,
    aspsp_name    TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    valid_until   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'AUTHORIZED',
    created_at    TEXT NOT NULL
);

-- Un compte est identifié par identification_hash, stable d'une autorisation à l'autre.
-- uid / session_id pointent vers la dernière autorisation valide.
CREATE TABLE accounts (
    hash              TEXT PRIMARY KEY,
    uid               TEXT,
    session_id        TEXT REFERENCES sessions(session_id),
    aspsp_name        TEXT NOT NULL,
    iban              TEXT,
    name              TEXT,
    details           TEXT,
    product           TEXT,
    currency          TEXT NOT NULL,
    cash_account_type TEXT,
    balance_cents     INTEGER,
    balance_type      TEXT,
    balance_date      TEXT,
    last_sync         TEXT,
    last_error        TEXT,
    raw               TEXT NOT NULL
);

CREATE TABLE transactions (
    id               INTEGER PRIMARY KEY,
    account_hash     TEXT NOT NULL REFERENCES accounts(hash),
    fingerprint      TEXT NOT NULL,
    status           TEXT NOT NULL,
    booking_date     TEXT,
    value_date       TEXT,
    transaction_date TEXT,
    amount_cents     INTEGER NOT NULL,   -- signé : négatif = débit
    currency         TEXT NOT NULL,
    counterparty     TEXT,
    label            TEXT NOT NULL,
    mcc              TEXT,
    raw              TEXT NOT NULL,
    first_seen       TEXT NOT NULL,
    UNIQUE (account_hash, fingerprint)
);
CREATE INDEX transactions_date ON transactions (account_hash, booking_date);
"#];

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("création de {}", dir.display()))?;
    }
    let mut conn = Connection::open(path).with_context(|| format!("ouverture de {}", path.display()))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    migrate(&mut conn)?;
    restrict_permissions(path);
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql).with_context(|| format!("migration {}", i + 1))?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

/// La base contient des données bancaires : lisible par son seul propriétaire.
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------- Autorisations en attente ----------

pub fn insert_pending(conn: &Connection, state: &str, aspsp_name: &str, aspsp_country: &str) -> Result<()> {
    // Nettoie les tentatives abandonnées.
    conn.execute("DELETE FROM pending_auth WHERE created_at < datetime('now', '-1 hour')", [])?;
    conn.execute(
        "INSERT INTO pending_auth (state, aspsp_name, aspsp_country, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
        params![state, aspsp_name, aspsp_country],
    )?;
    Ok(())
}

/// Consomme un `state` (usage unique). Renvoie le nom de la banque s'il était valide.
pub fn take_pending(conn: &Connection, state: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "DELETE FROM pending_auth WHERE state = ?1 AND created_at >= datetime('now', '-1 hour') RETURNING aspsp_name",
            [state],
            |r| r.get(0),
        )
        .optional()?)
}

// ---------- Lecture pour le tableau de bord ----------

pub struct AccountRow {
    pub aspsp_name: String,
    pub iban: Option<String>,
    pub name: Option<String>,
    pub product: Option<String>,
    pub currency: String,
    pub balance_cents: Option<i64>,
    pub balance_date: Option<String>,
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
    pub valid_until: Option<String>,
    pub session_status: Option<String>,
    pub tx_count: i64,
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<AccountRow>> {
    let mut stmt = conn.prepare(
        "SELECT a.aspsp_name, a.iban, a.name, a.product, a.currency, a.balance_cents,
                a.balance_date, a.last_sync, a.last_error, s.valid_until, s.status,
                (SELECT COUNT(*) FROM transactions t WHERE t.account_hash = a.hash)
         FROM accounts a LEFT JOIN sessions s ON s.session_id = a.session_id
         ORDER BY a.aspsp_name, a.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(AccountRow {
            aspsp_name: r.get(0)?,
            iban: r.get(1)?,
            name: r.get(2)?,
            product: r.get(3)?,
            currency: r.get(4)?,
            balance_cents: r.get(5)?,
            balance_date: r.get(6)?,
            last_sync: r.get(7)?,
            last_error: r.get(8)?,
            valid_until: r.get(9)?,
            session_status: r.get(10)?,
            tx_count: r.get(11)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub struct TxRow {
    pub date: Option<String>,
    pub status: String,
    pub amount_cents: i64,
    pub currency: String,
    pub counterparty: Option<String>,
    pub label: String,
    pub account: String,
}

pub fn recent_transactions(conn: &Connection, limit: i64) -> Result<Vec<TxRow>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(t.booking_date, t.value_date, t.transaction_date) AS d, t.status, t.amount_cents,
                t.currency, t.counterparty, t.label, COALESCE(a.name, a.product, a.iban, a.aspsp_name)
         FROM transactions t JOIN accounts a ON a.hash = t.account_hash
         ORDER BY d DESC, t.id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(TxRow {
            date: r.get(0)?,
            status: r.get(1)?,
            amount_cents: r.get(2)?,
            currency: r.get(3)?,
            counterparty: r.get(4)?,
            label: r.get(5)?,
            account: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
