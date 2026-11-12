//! Suggestions de règles : libellés similaires (même enseigne sous plusieurs noms : « AMZN MKTP FR »,
//! « AMAZON PAYMENTS »…) et marchands récurrents, avec la catégorie majoritaire actuelle.
//!
//! Les motifs proposés suivent la sémantique des règles (`contient`, insensible à la casse) : les
//! opérations comptées sont exactement celles que la règle toucherait.

use crate::merchant;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};

/// Mots trop génériques pour faire une règle à eux seuls (banque, intermédiaires de paiement, formes juridiques…).
const STOP: &[&str] = &[
    "PAIEMENT", "PAIEMENTS", "PRLV", "PRELEVEMENT", "SEPA", "CARTE", "INST", "PAYMENT", "PAYMENTS", "FROM",
    "REFUND", "SENT", "REVOLUT", "TRANSFER", "INSTANT", "EXCHANGED", "ACCOUNT", "INVESTMENT", "SAVINGS",
    "ACCESS", "PENDING", "PAYPAL", "SUMUP", "STRIPE", "LYDIA", "IZLY", "SMONEY", "ALMA", "EUROPE", "FRANCE",
    "SARL", "INC.", "CORP", "LTD", "GMBH", "MONTHLY", "BILL", "PLAN", "FEE", "FEES", "SERVICE", "SERVICES",
    "CARD", "DELIVERY", "SHOP", "STORE", "ONLINE", "PAYOUT", "MONSIEUR", "MADAME", "VERS", "AVEC", "POUR",
    "DANS", "SUBVENTION", "AIDE", "CAUTION", "WWW.", "HTTPS", "HTTP",
];

/// Enseignes qui facturent sous plusieurs noms : regroupées en une seule suggestion.
const ALIASES: &[(&str, &str)] = &[("AMZN", "AMAZON"), ("UBR", "UBER")];

#[derive(Serialize, Debug)]
pub struct Suggestion {
    /// Identifiant stable (motifs joints), utilisé pour « ignorer ».
    pub key: String,
    pub patterns: Vec<String>,
    /// Catégorie majoritaire (pondérée par la source), `None` si rien n'est classé.
    pub category_id: Option<i64>,
    /// Part du vote majoritaire (0 à 1).
    pub share: f64,
    pub matches: usize,
    pub months: usize,
    /// Opérations dont la catégorie changerait si la suggestion est acceptée telle quelle.
    pub recategorized: usize,
    /// `similar` : plusieurs libellés ; `recurring` : un seul marchand, plusieurs mois ; `frequent` sinon.
    pub reason: &'static str,
    /// Libellés concernés, du plus fréquent au moins fréquent.
    pub merchants: Vec<String>,
    /// Répartition actuelle des catégories (`None` = non classé).
    pub categories: Vec<CatCount>,
}

#[derive(Serialize, Debug)]
pub struct CatCount {
    pub category_id: Option<i64>,
    pub count: usize,
}

struct Tx {
    id: i64,
    text: String,
    merchant: String,
    debit: bool,
    month: String,
    category: Option<i64>,
    source: Option<String>,
    confidence: Option<f64>,
}

const DISMISSED_KEY: &str = "rule_suggestions_dismissed";

pub fn dismissed(conn: &Connection) -> Result<BTreeSet<String>> {
    let raw: Option<String> =
        conn.query_row("SELECT value FROM app_settings WHERE key = ?1", [DISMISSED_KEY], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

pub fn dismiss(conn: &Connection, key: &str) -> Result<()> {
    let mut set = dismissed(conn)?;
    set.insert(key.to_string());
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![DISMISSED_KEY, serde_json::to_string(&set)?],
    )?;
    Ok(())
}

pub fn reset_dismissed(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM app_settings WHERE key = ?1", [DISMISSED_KEY])?;
    Ok(())
}

pub fn suggestions(conn: &Connection) -> Result<Vec<Suggestion>> {
    // Même texte que l'application des règles (`upper` de SQLite : ASCII uniquement).
    // Premier mot des paiements carte → mots qui le suivent.
    let mut card_heads: HashMap<String, HashSet<String>> = HashMap::new();
    let mut card_merchants: HashSet<String> = HashSet::new();
    let mut txs: Vec<Tx> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, upper(label || ' ' || COALESCE(counterparty, '') || ' ' || COALESCE(merchant, '')), merchant,
                amount_cents < 0, substr(day, 1, 7), category_id, category_source, category_confidence, label
         FROM transactions WHERE amount_cents <> 0 AND merchant IS NOT NULL",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let tx = Tx {
            id: r.get(0)?,
            text: r.get(1)?,
            merchant: r.get(2)?,
            debit: r.get(3)?,
            month: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            category: r.get(5)?,
            source: r.get(6)?,
            confidence: r.get(7)?,
        };
        // Crédit Mutuel : « PAIEMENT CB 0511 TOULOUSE LIDL » → la ville vient en premier.
        if merchant::is_card_payment(&r.get::<_, String>(8)?) {
            card_merchants.insert(tx.merchant.clone());
            if let [first, next, ..] = words(&tx.merchant)[..] {
                card_heads.entry(first.to_string()).or_default().insert(next.to_string());
            }
        }
        txs.push(tx);
    }
    drop(rows);
    drop(stmt);
    // Une ville précède plusieurs marchands (« TOULOUSE LIDL », « TOULOUSE AUCHAN ») ; un premier mot
    // toujours suivi du même (« TISSEO OPEN P ») est plutôt l'enseigne elle-même.
    let locations: HashSet<String> =
        card_heads.into_iter().filter(|(_, next)| next.len() >= 2).map(|(first, _)| first).collect();

    let holders: HashSet<String> = conn
        .prepare("SELECT DISTINCT name FROM accounts WHERE name IS NOT NULL")?
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|n| n.ok().and_then(|n| merchant::holder_name(&n)))
        .flat_map(|n| words(&n).into_iter().map(str::to_string).collect::<Vec<_>>())
        .collect();
    let dismissed = dismissed(conn)?;

    // Marchands déjà traités comme virements internes : jamais candidats.
    let transfer_merchants: HashSet<&str> =
        txs.iter().filter(|t| t.source.as_deref() == Some("transfer")).map(|t| t.merchant.as_str()).collect();

    // --- Candidats « enseigne » : le premier mot significatif d'un libellé (« AMAZON » dans
    // « REFUND FROM AMAZON PAYMENTS », « LIDL » dans « TOULOUSE LIDL »), regroupé avec ses alias ---
    let mut groups: HashMap<String, BTreeSet<String>> = HashMap::new();
    let merchants: BTreeSet<&str> =
        txs.iter().map(|t| t.merchant.as_str()).filter(|m| !transfer_merchants.contains(m)).collect();
    let significant = |m: &str| -> Vec<(&'static str, String)> {
        words(m)
            .into_iter()
            .filter_map(|w| {
                let alias = ALIASES.iter().find(|(a, _)| *a == w).map(|(_, canon)| *canon);
                let ok = alias.is_some()
                    || (w.chars().count() >= 4
                        && !w.chars().any(|c| c.is_ascii_digit())
                        && !STOP.contains(&w)
                        && !locations.contains(w)
                        && !holders.contains(w));
                ok.then(|| (alias.unwrap_or(""), w.to_string()))
            })
            .take(2)
            .collect()
    };
    // Enseigne présumée de chaque libellé, plus le mot suivant pour un paiement carte
    // (ville vue une seule fois : « WATTR LIDL »).
    let mut first_words: HashMap<&str, (String, Option<String>)> = HashMap::new();
    for t in &txs {
        let mut sig = significant(&t.merchant).into_iter().map(|(_, w)| w);
        if let Some(first) = sig.next() {
            let second = sig.next().filter(|_| card_merchants.contains(&t.merchant));
            first_words.insert(t.merchant.as_str(), (first, second));
        }
    }
    for m in &merchants {
        let n = if card_merchants.contains(*m) { 2 } else { 1 };
        for (alias, w) in significant(m).into_iter().take(n) {
            let canon = if alias.is_empty() { w.clone() } else { alias.to_string() };
            groups.entry(canon).or_default().insert(w);
        }
    }
    let mut candidates: Vec<(Vec<String>, bool)> = groups.into_values().map(|p| (p.into_iter().collect(), true)).collect();

    // --- Candidats « marchand » : un libellé normalisé récurrent ---
    let mut per_merchant: HashMap<&str, (usize, HashSet<&str>)> = HashMap::new();
    for t in &txs {
        let e = per_merchant.entry(t.merchant.as_str()).or_default();
        e.0 += 1;
        e.1.insert(t.month.as_str());
    }
    for (m, (n, months)) in &per_merchant {
        if m.chars().count() >= 4 && !transfer_merchants.contains(m) && (*n >= 3 || (*n >= 2 && months.len() >= 2)) {
            candidates.push((vec![m.to_string()], false));
        }
    }

    let mut out: Vec<(Suggestion, Vec<i64>)> = Vec::new();
    for (patterns, brand) in candidates {
        if let Some(s) = evaluate(&txs, &first_words, patterns, brand)
            && !dismissed.contains(&s.0.key)
        {
            out.push(s);
        }
    }

    // Les enseignes (plusieurs libellés) d'abord, puis les plus grosses : un candidat déjà couvert à 80 %
    // par une suggestion retenue n'apporte rien.
    out.sort_by(|a, b| {
        (b.0.merchants.len() > 1)
            .cmp(&(a.0.merchants.len() > 1))
            .then(b.0.matches.cmp(&a.0.matches))
            .then(a.0.key.cmp(&b.0.key))
    });
    let mut covered: HashSet<i64> = HashSet::new();
    let mut kept: Vec<Suggestion> = Vec::new();
    for (s, ids) in out {
        let already = ids.iter().filter(|id| covered.contains(id)).count();
        if already * 5 >= ids.len() * 4 {
            continue;
        }
        covered.extend(ids);
        kept.push(s);
    }
    kept.sort_by(|a, b| b.recategorized.cmp(&a.recategorized).then(b.matches.cmp(&a.matches)));
    kept.truncate(40);
    Ok(kept)
}

/// `pattern` apparaît dans `text` au début d'un mot (« STEAM » dans « STEAMGAMES.COM » : oui).
fn at_word_start(text: &str, pattern: &str) -> bool {
    text.match_indices(pattern).any(|(i, _)| text[..i].chars().next_back().is_none_or(|c| !c.is_alphanumeric()))
}

/// Mots d'un libellé normalisé (séparés par tout ce qui n'est ni lettre ni chiffre).
fn words(s: &str) -> Vec<&str> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect()
}

/// `first_words` : premier mot significatif de chaque libellé normalisé (l'enseigne présumée).
fn evaluate(
    txs: &[Tx],
    first_words: &HashMap<&str, (String, Option<String>)>,
    patterns: Vec<String>,
    brand: bool,
) -> Option<(Suggestion, Vec<i64>)> {
    let matched: Vec<&Tx> = txs.iter().filter(|t| patterns.iter().any(|p| t.text.contains(p.as_str()))).collect();
    if matched.len() < 2 {
        return None;
    }
    // La règle teste « contient » : refuser un motif qui attraperait un milieu de mot
    // (« EXPRESS » dans « ALIEXPRESS », « E OVH » dans « CSE OVH »).
    if !matched.iter().all(|t| patterns.iter().any(|p| at_word_start(&t.text, p))) {
        return None;
    }
    // Une règle passe avant la détection des virements : ne jamais en voler un.
    if matched.iter().any(|t| t.source.as_deref() == Some("transfer")) {
        return None;
    }
    // Déjà entièrement couvert par des règles ou des choix manuels.
    let open: Vec<&&Tx> = matched.iter().filter(|t| !matches!(t.source.as_deref(), Some("rule" | "user"))).collect();
    if open.is_empty() {
        return None;
    }

    let mut merchant_counts: HashMap<&str, usize> = HashMap::new();
    for t in &matched {
        *merchant_counts.entry(t.merchant.as_str()).or_default() += 1;
    }
    if brand && merchant_counts.len() < 2 {
        return None; // un seul libellé : c'est le candidat « marchand » qui s'en charge
    }
    // L'enseigne doit être le premier mot de chaque libellé touché : « OPEN » ne doit pas
    // regrouper « OPENFRONT.IO » et « TISSEO OPEN P ». Le 2e mot d'un paiement carte est toléré
    // (ville non reconnue), mais exige alors une catégorie nettement majoritaire.
    let starts = |w: &str| patterns.iter().any(|p| w.starts_with(p.as_str()));
    let mut loose = false;
    if brand {
        for m in merchant_counts.keys() {
            match first_words.get(m) {
                None => {}
                Some((first, _)) if starts(first) => {}
                Some((_, Some(second))) if starts(second) => loose = true,
                Some(_) => return None,
            }
        }
    }

    // Sens : quelques remboursements sont tolérés, pas un mélange dépenses / revenus (« OVH »).
    let debits = matched.iter().filter(|t| t.debit).count();
    let credits = matched.len() - debits;
    if debits.min(credits) * 4 > matched.len() {
        return None;
    }
    let debit = debits >= credits;

    // Vote pondéré par la fiabilité de la source, sur les opérations du sens majoritaire.
    let mut votes: HashMap<i64, f64> = HashMap::new();
    for t in matched.iter().filter(|t| t.debit == debit) {
        let Some(c) = t.category else { continue };
        let w = match t.source.as_deref() {
            Some("user" | "rule") => 3.0,
            Some("memory") => 2.0,
            Some("ai") => t.confidence.unwrap_or(0.5).max(0.3),
            _ => 0.0,
        };
        *votes.entry(c).or_default() += w;
    }
    let total: f64 = votes.values().sum();
    let (category_id, share) = votes
        .iter()
        .max_by(|a, b| a.1.total_cmp(b.1).then(b.0.cmp(a.0)))
        .map(|(c, w)| (Some(*c), w / total))
        .unwrap_or((None, 0.0));
    // Trop dispersé (mot de lieu, intermédiaire de paiement…) : pas une enseigne.
    if category_id.is_some() && (share < if loose { 0.75 } else { 0.5 } || votes.len() > 3) {
        return None;
    }

    let mut cat_counts: HashMap<Option<i64>, usize> = HashMap::new();
    for t in &matched {
        *cat_counts.entry(t.category).or_default() += 1;
    }
    let mut categories: Vec<CatCount> =
        cat_counts.into_iter().map(|(category_id, count)| CatCount { category_id, count }).collect();
    categories.sort_by_key(|c| std::cmp::Reverse(c.count));

    let recategorized = open.iter().filter(|t| t.category != category_id || category_id.is_none()).count();
    let months: HashSet<&str> = matched.iter().map(|t| t.month.as_str()).collect();
    let mut merchants: Vec<(&str, usize)> = merchant_counts.into_iter().collect();
    merchants.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));

    let reason = if merchants.len() > 1 {
        "similar"
    } else if months.len() >= 2 {
        "recurring"
    } else {
        "frequent"
    };
    let ids = matched.iter().map(|t| t.id).collect();
    Some((
        Suggestion {
            key: patterns.join(" | "),
            patterns,
            category_id,
            share,
            matches: matched.len(),
            months: months.len(),
            recategorized,
            reason,
            merchants: merchants.into_iter().map(|(m, _)| merchant::display(m)).collect(),
            categories,
        },
        ids,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = crate::db::open(std::path::Path::new(":memory:")).unwrap();
        c.execute(
            "INSERT INTO accounts (hash, aspsp_name, name, currency, raw) VALUES ('a', 'B', 'M Jean Dupont', 'EUR', '{}')",
            [],
        )
        .unwrap();
        c
    }

    fn add(c: &Connection, id: i64, day: &str, label: &str, amount: i64, cat: Option<i64>, source: Option<&str>) {
        c.execute(
            "INSERT INTO transactions (id, account_hash, fingerprint, status, booking_date, amount_cents, currency,
                                       label, raw, first_seen, merchant, category_id, category_source, category_confidence)
             VALUES (?1, 'a', ?1, 'BOOK', ?2, ?3, 'EUR', ?4, '{}', ?2, ?5, ?6, ?7, 0.8)",
            params![id, day, amount, label, merchant::key(label), cat, source],
        )
        .unwrap();
    }

    #[test]
    fn regroupe_les_alias_et_ignore_les_villes() {
        let c = conn();
        let shopping = 11;
        let courses = 1;
        let resto = 2;
        add(&c, 1, "2026-01-05", "Amazon Payments", -1000, Some(shopping), Some("ai"));
        add(&c, 2, "2026-02-05", "Amazon Payments", -2000, Some(shopping), Some("ai"));
        add(&c, 3, "2026-03-05", "Amazon Payments", -2000, Some(shopping), Some("ai"));
        add(&c, 4, "2026-03-07", "Amzn Mktp Fr", -1500, Some(courses), Some("ai"));
        add(&c, 5, "2026-03-09", "Amzn Mktp Fr", -1500, Some(courses), Some("ai"));
        add(&c, 6, "2026-03-10", "Refund from Amazon Payments", 1500, Some(28), Some("ai"));
        add(&c, 7, "2026-03-01", "PAIEMENT CB 0103 TOULOUSE LIDL 0927 CARTE 1234", -3000, Some(courses), Some("ai"));
        add(&c, 8, "2026-04-01", "PAIEMENT CB 0104 TOULOUSE CROUS CARTE 1234", -300, Some(resto), Some("ai"));
        add(&c, 9, "2026-04-02", "PAIEMENT CB 0204 LILLE LIDL CARTE 1234", -2500, Some(courses), Some("ai"));

        let s = suggestions(&c).unwrap();
        let amazon = s.iter().find(|s| s.patterns.contains(&"AMAZON".to_string())).expect("amazon");
        assert_eq!(amazon.patterns, vec!["AMAZON", "AMZN"]);
        assert_eq!(amazon.category_id, Some(shopping));
        assert_eq!(amazon.matches, 6);
        assert_eq!(amazon.recategorized, 3); // 2 « Amzn Mktp » + le remboursement
        assert!(s.iter().any(|s| s.patterns == vec!["LIDL"] && s.category_id == Some(courses)));
        assert!(!s.iter().any(|s| s.patterns.iter().any(|p| p == "TOULOUSE")));

        dismiss(&c, &amazon.key).unwrap();
        assert!(!suggestions(&c).unwrap().iter().any(|s| s.key == amazon.key));
    }

    #[test]
    fn rejette_les_melanges_et_les_virements() {
        let c = conn();
        add(&c, 1, "2026-01-05", "Paypal *ovh", -1000, Some(10), Some("ai"));
        add(&c, 2, "2026-02-05", "Paypal *ovh", -1000, Some(10), Some("ai"));
        add(&c, 3, "2026-01-28", "E 01 2026 Payment from Ovh", 200000, Some(26), Some("ai"));
        add(&c, 4, "2026-02-28", "E 02 2026 Payment from Ovh", 200000, Some(26), Some("ai"));
        add(&c, 5, "2026-01-02", "To investment account", -5000, Some(31), Some("transfer"));
        add(&c, 6, "2026-02-02", "To investment account", -5000, Some(31), Some("transfer"));
        let s = suggestions(&c).unwrap();
        assert!(!s.iter().any(|s| s.patterns == vec!["OVH"]), "{s:?}");
        assert!(s.iter().any(|s| s.patterns == vec!["PAYPAL *OVH"]));
        assert!(!s.iter().any(|s| s.patterns.iter().any(|p| p.contains("INVESTMENT"))));
    }

    #[test]
    fn mots_generiques_et_milieux_de_mot() {
        let c = conn();
        add(&c, 1, "2026-01-05", "Www Aliexpress Com", -1000, Some(11), Some("ai"));
        add(&c, 2, "2026-02-05", "Federal Express France", -1000, Some(11), Some("ai"));
        add(&c, 3, "2026-01-06", "Steam Purchase", -1000, Some(15), Some("ai"));
        add(&c, 4, "2026-02-06", "steamgames.com", -1000, Some(15), Some("ai"));
        add(&c, 5, "2026-03-06", "Wl *steam Purchase", -1000, Some(10), Some("ai"));
        let s = suggestions(&c).unwrap();
        assert!(!s.iter().any(|s| s.patterns.iter().any(|p| p == "EXPRESS" || p == "PURCHASE")), "{s:?}");
        assert!(s.iter().any(|s| s.patterns == vec!["STEAM"] && s.matches == 3));
        assert!(at_word_start("WL *STEAM PURCHASE", "STEAM"));
        add(&c, 6, "2026-01-07", "openfront.io", -500, Some(15), Some("ai"));
        add(&c, 7, "2026-02-07", "Tisseo Open P", -170, Some(6), Some("ai"));
        add(&c, 8, "2026-03-07", "Open", -500, Some(15), Some("ai"));
        assert!(!suggestions(&c).unwrap().iter().any(|s| s.patterns == vec!["OPEN"]));
        assert!(!at_word_start("SUBVENTION S CSE OVH", "E OVH"));
    }
}
