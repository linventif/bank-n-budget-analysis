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
"#, r#"
CREATE TABLE categories (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    icon         TEXT NOT NULL,                    -- nom Iconify, ex. lucide:shopping-cart
    kind         TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
    description  TEXT NOT NULL DEFAULT '',         -- aide l'IA à choisir
    budget_cents INTEGER,                          -- budget mensuel (catégories de dépenses)
    position     INTEGER NOT NULL DEFAULT 0,
    role         TEXT UNIQUE                       -- 'internal' | 'savings' : utilisé par la détection des virements
);

-- « Si le libellé contient <pattern>, alors <catégorie> » (insensible à la casse).
CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    pattern     TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
);

ALTER TABLE transactions ADD COLUMN merchant TEXT;              -- libellé normalisé (clé marchand)
ALTER TABLE transactions ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN category_source TEXT;       -- user | rule | memory | transfer | ai
ALTER TABLE transactions ADD COLUMN category_confidence REAL;
ALTER TABLE transactions ADD COLUMN day TEXT
    GENERATED ALWAYS AS (COALESCE(booking_date, value_date, transaction_date)) VIRTUAL;
CREATE INDEX transactions_day ON transactions (day);
CREATE INDEX transactions_merchant ON transactions (merchant);
CREATE INDEX transactions_category ON transactions (category_id);

-- Vue unique pour toutes les analyses : une opération sans catégorie compte comme
-- dépense (débit) ou revenu (crédit) ; les montants nuls (pré-autorisations) sont ignorés.
CREATE VIEW ledger AS
SELECT t.id, t.account_hash, t.day, substr(t.day, 1, 7) AS month, t.amount_cents, t.currency,
       t.label, t.counterparty, t.merchant, t.status, t.category_id, t.category_source,
       t.category_confidence,
       COALESCE(c.kind, CASE WHEN t.amount_cents < 0 THEN 'expense' ELSE 'income' END) AS kind
FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
WHERE t.amount_cents <> 0 AND t.day IS NOT NULL;
"#, r#"
-- Argent échangé avec d'autres personnes : ni un virement interne (il sort vraiment du budget), ni un remboursement.
INSERT OR IGNORE INTO categories (name, icon, kind, description, position) VALUES
    ('Envois à des proches', 'lucide:send', 'expense',
     'argent envoyé à une autre personne (ami, famille, colocataire) par virement, Lydia, Wero, PayPal à un particulier', 31),
    ('Reçu de proches', 'lucide:hand-heart', 'income',
     'argent reçu d''une autre personne (ami, famille) par virement, Lydia, Wero, PayPal, hors remboursement explicite', 32);

-- Descriptions précisées, seulement si elles n'ont pas été modifiées.
UPDATE categories SET description = 'UNIQUEMENT entre mes propres comptes (même titulaire) : virements à mon nom, rechargements, conversions de devises. Jamais un virement avec une autre personne.'
 WHERE role = 'internal' AND description = 'virements entre mes propres comptes, rechargements de compte, conversions de devises';
UPDATE categories SET description = 'versements vers ou depuis un livret, une épargne, un coffre, un compte d''investissement, un robo-advisor (portfolio), des actions ou des cryptomonnaies'
 WHERE role = 'savings' AND description = 'versements vers ou depuis un livret, une épargne, un coffre ou un compte d''investissement';
UPDATE categories SET description = 'streaming, logiciels, cloud, IA, applications, jeux en ligne, presse en ligne (Netflix, Spotify, Deezer, Apple, Google, GitHub, Anthropic, OpenAI, Midjourney, Proton)'
 WHERE name = 'Abonnements & services en ligne' AND description = 'streaming, logiciels, cloud, IA, applications, presse en ligne (Netflix, Spotify, Deezer, Apple, Google, GitHub, Anthropic, OpenAI)';
UPDATE categories SET description = 'remboursements d''achats, de frais bancaires, de santé (CPAM, mutuelle, assurance), d''une caution'
 WHERE name = 'Remboursements' AND description = 'remboursements d''achats, de frais bancaires, de santé (CPAM, mutuelle, assurance), d''un proche qui rembourse sa part';
UPDATE categories SET description = 'dépenses qui ne rentrent dans aucune autre catégorie (frais postaux, services divers)'
 WHERE name = 'Autres dépenses' AND description = 'dépenses qui ne rentrent dans aucune autre catégorie';
"#, r#"
-- Budgets prévisionnels, structurés comme un tableur : postes (lignes) × périodes (colonnes).
CREATE TABLE budgets (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE budget_periods (
    id          INTEGER PRIMARY KEY,
    budget_id   INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    months      INTEGER NOT NULL DEFAULT 1 CHECK (months BETWEEN 1 AND 24),
    start_month TEXT,                -- 'AAAA-MM' : période appliquée automatiquement à partir de ce mois
    position    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE budget_lines (
    id          INTEGER PRIMARY KEY,
    budget_id   INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    section     TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'salary', 'info')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    match       TEXT,                -- « le libellé contient » : rattache les opérations au poste
    once_cents  INTEGER,             -- montant annuel / ponctuel
    position    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE budget_amounts (
    line_id      INTEGER NOT NULL REFERENCES budget_lines(id) ON DELETE CASCADE,
    period_id    INTEGER NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    PRIMARY KEY (line_id, period_id)
);
CREATE INDEX budget_lines_budget ON budget_lines (budget_id, position);
"#, r#"
-- Accès distant : passkeys (WebAuthn) et sessions (seul le hachage du jeton est stocké).
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE passkeys (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,
    passkey       TEXT NOT NULL,          -- état webauthn-rs (clé publique, compteur), JSON
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
);
CREATE TABLE auth_sessions (
    id           INTEGER PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,    -- SHA-256 du jeton du cookie
    passkey_id   INTEGER REFERENCES passkeys(id) ON DELETE CASCADE,
    user_agent   TEXT,
    ip           TEXT,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
);
"#, r#"
-- Calendrier d'un budget : quelle période s'applique à quel mois (ex. alternance cours / entreprise).
CREATE TABLE budget_calendar (
    budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    month     TEXT NOT NULL,
    period_id INTEGER NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
    PRIMARY KEY (budget_id, month)
);
"#];

/// Catégories proposées au départ (toutes modifiables). Les descriptions guident l'IA.
const DEFAULT_CATEGORIES: &[(&str, &str, &str, &str)] = &[
    ("Courses", "lucide:shopping-cart", "expense", "supermarchés, épiceries, boulangeries, marchés (Lidl, Carrefour, Auchan, Leclerc, Intermarché, Monoprix, Franprix, Picard)"),
    ("Restaurants & bars", "lucide:utensils", "expense", "restaurants, fast-food, cafés, bars, kebabs, livraison de repas (Uber Eats, Deliveroo), restaurant universitaire (RU)"),
    ("Logement", "lucide:house", "expense", "loyer, charges, colocation, assurance habitation"),
    ("Énergie & eau", "lucide:zap", "expense", "électricité, gaz, eau (EDF, Engie, TotalEnergies électricité, Veolia)"),
    ("Téléphone & internet", "lucide:smartphone", "expense", "forfait mobile, box internet (Free, Orange, SFR, Bouygues, Sosh, RED)"),
    ("Transports", "lucide:train-front", "expense", "train, métro, bus, tram, VTC, taxi, vélos et trottinettes en libre-service (SNCF, RATP, Tisséo, Ilévia, Uber, Bolt, Lime, BlaBlaCar)"),
    ("Carburant & péages", "lucide:fuel", "expense", "stations-service, péages, recharge électrique (Total, Shell, Esso, BP, Avia, Vinci Autoroutes, Sanef)"),
    ("Véhicule", "lucide:car", "expense", "entretien, réparation, contrôle technique, parking, assurance auto, location de voiture"),
    ("Voyages", "lucide:plane", "expense", "billets d'avion, hôtels, locations de vacances (Airbnb, Booking), séjours"),
    ("Abonnements & services en ligne", "lucide:repeat", "expense", "streaming, logiciels, cloud, IA, applications, presse en ligne (Netflix, Spotify, Deezer, Apple, Google, GitHub, Anthropic, OpenAI)"),
    ("Shopping", "lucide:shopping-bag", "expense", "vêtements, chaussures, high-tech, achats en ligne, grands magasins (Amazon, Fnac, Decathlon, Zara, AliExpress)"),
    ("Maison & bricolage", "lucide:hammer", "expense", "meubles, décoration, bricolage, jardinage, électroménager (Ikea, Leroy Merlin, Castorama, Action)"),
    ("Santé", "lucide:heart-pulse", "expense", "pharmacie, médecin, dentiste, opticien, laboratoire, mutuelle, matériel médical"),
    ("Sport", "lucide:dumbbell", "expense", "salle de sport, clubs, licences, équipement sportif (Basic Fit, Fitness Park, On Air)"),
    ("Loisirs & sorties", "lucide:ticket", "expense", "cinéma, concerts, musées, jeux vidéo, livres, hobbies, soirées"),
    ("Beauté & soins", "lucide:sparkles", "expense", "coiffeur, barbier, cosmétiques, soins du corps"),
    ("Éducation", "lucide:graduation-cap", "expense", "frais de scolarité, inscriptions, cours, formations, fournitures"),
    ("Cadeaux & dons", "lucide:gift", "expense", "cadeaux offerts, dons, cagnottes"),
    ("Frais bancaires", "lucide:landmark", "expense", "cotisations de carte ou de compte, commissions, agios, frais de change"),
    ("Impôts & taxes", "lucide:receipt-text", "expense", "impôt sur le revenu, taxes, amendes, frais administratifs"),
    ("Assurances", "lucide:shield-check", "expense", "assurances hors logement et véhicule (prévoyance, assurance de prêt, assurance appareil)"),
    ("Retraits d'espèces", "lucide:banknote", "expense", "retraits d'argent liquide au distributeur (DAB, RETRAIT)"),
    ("Crédits & paiements fractionnés", "lucide:calendar-clock", "expense", "remboursements de prêt, crédits, paiements en plusieurs fois (PayPal 4x, Alma, Klarna, Oney)"),
    ("Animaux", "lucide:paw-print", "expense", "vétérinaire, nourriture et accessoires pour animaux"),
    ("Autres dépenses", "lucide:circle-ellipsis", "expense", "dépenses qui ne rentrent dans aucune autre catégorie"),
    ("Salaire", "lucide:briefcase-business", "income", "salaire, paie, gratification de stage, primes, indemnités de travail"),
    ("Aides & allocations", "lucide:hand-coins", "income", "CAF, APL, bourses, aides de l'État, France Travail"),
    ("Remboursements", "lucide:undo-2", "income", "remboursements d'achats, de frais bancaires, de santé (CPAM, mutuelle, assurance), d'un proche qui rembourse sa part"),
    ("Autres revenus", "lucide:coins", "income", "ventes (Vinted, Leboncoin), intérêts, cadeaux reçus, revenus divers"),
    ("Virements internes", "lucide:arrow-left-right", "transfer", "virements entre mes propres comptes, rechargements de compte, conversions de devises"),
    ("Épargne & placements", "lucide:piggy-bank", "transfer", "versements vers ou depuis un livret, une épargne, un coffre ou un compte d'investissement"),
];

fn seed_categories(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let mut stmt =
        tx.prepare("INSERT INTO categories (name, icon, kind, description, position) VALUES (?1, ?2, ?3, ?4, ?5)")?;
    for (i, (name, icon, kind, desc)) in DEFAULT_CATEGORIES.iter().enumerate() {
        stmt.execute(params![name, icon, kind, desc, i as i64])?;
    }
    tx.execute("UPDATE categories SET role = 'internal' WHERE name = 'Virements internes'", [])?;
    tx.execute("UPDATE categories SET role = 'savings' WHERE name = 'Épargne & placements'", [])?;
    Ok(())
}

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
        if i + 1 == 2 {
            seed_categories(&tx)?;
        }
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
