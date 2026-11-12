//! Normalisation des libellés : « PAIEMENT MOB 0511 TOULOUSE LIDL 0927 CARTE 1234 » → « TOULOUSE LIDL ».
//! La clé obtenue regroupe les opérations d'un même marchand (catégorisation, récurrences, top marchands).

use regex::Regex;
use std::sync::LazyLock;

static CARD_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(PAIEMENT|PAIE|ACHAT)\s+(CB|MOB|PSC|SANS CONTACT|CARTE)?\s*\d{4}\s+").unwrap());
static CARD_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+CARTE\s+\S+\s*$").unwrap());
static DIRECT_DEBIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^PRLV(\s+SEPA)?\s+").unwrap());
static TRANSFER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^VIR(EMENT)?\.?(\s+SEPA)?(\s+INST)?\s+").unwrap());
static CIVILITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(M|MR|MME|MLLE|MONSIEUR|MADAME|MADEMOISELLE)\.?\s+").unwrap());

const MONTHS: &[&str] = &[
    "JANVIER", "FEVRIER", "FÉVRIER", "MARS", "AVRIL", "MAI", "JUIN", "JUILLET", "AOUT", "AOÛT", "SEPTEMBRE",
    "OCTOBRE", "NOVEMBRE", "DECEMBRE", "DÉCEMBRE",
];

/// Clé marchand (majuscules, sans dates, numéros de carte, références ni mois).
pub fn key(label: &str) -> String {
    let up = label.to_uppercase();
    let up = up.trim();

    // Revolut répète souvent l'émetteur : « VIR DE M X Payment from M X ».
    let up = match up.split_once(" PAYMENT FROM ") {
        Some((before, after)) if squash(before).contains(&squash(after)) => before.to_string(),
        Some((before, after)) => format!("{before} {after}"),
        None => up.to_string(),
    };

    let s = CARD_PREFIX.replace(&up, "");
    let s = CARD_SUFFIX.replace(&s, "");
    let s = DIRECT_DEBIT.replace(&s, "PRLV ");
    let s = TRANSFER.replace(&s, "VIR ");

    let tokens: Vec<&str> = s
        .split_whitespace()
        .filter(|t| !t.chars().any(|c| c.is_ascii_digit()))
        .filter(|t| t.chars().any(|c| c.is_alphanumeric()))
        .filter(|t| !MONTHS.contains(t))
        .collect();
    let out = tokens.join(" ");
    let out = if out.is_empty() { up.split_whitespace().collect::<Vec<_>>().join(" ") } else { out };
    out.chars().take(80).collect()
}

/// Paiement par carte Crédit Mutuel (« PAIEMENT CB 0511 VILLE MARCHAND … ») : la clé commence par la ville.
pub fn is_card_payment(label: &str) -> bool {
    CARD_PREFIX.is_match(label.to_uppercase().trim())
}

/// « M JEAN DUPONT » et « Jean Dupont » → « JEAN DUPONT ».
pub fn holder_name(account_name: &str) -> Option<String> {
    let up = format!("{} ", account_name.to_uppercase());
    let s = CIVILITY.replace_all(&up, "");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    // Un nom de titulaire plausible : au moins deux mots, pas un nom de produit (« COMPTE COURANT »).
    let words = s.split(' ').count();
    (words >= 2 && !s.contains("COMPTE") && !s.contains("LIVRET") && s.len() >= 6).then_some(s)
}

/// Version compacte pour comparer des noms (casse, accents, espaces et tirets ignorés).
pub fn squash(s: &str) -> String {
    let padded = format!("{} ", s.to_uppercase());
    CIVILITY.replace_all(&padded, "").chars().map(fold).filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Clés de comparaison d'un titulaire : nom complet, et prénom + premier nom
/// (tolère les fautes ou troncatures en fin de nom : « DUPONTMARTN »).
pub fn holder_keys(holder: &str) -> Vec<String> {
    let mut keys = vec![squash(holder)];
    let words: Vec<String> = holder.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(squash).collect();
    if words.len() >= 3 {
        let short = format!("{}{}", words[0], words[1]);
        if short.len() >= 10 {
            keys.push(short);
        }
    }
    keys.retain(|k| k.len() >= 6);
    keys.dedup();
    keys
}

fn fold(c: char) -> char {
    match c {
        'À' | 'Â' | 'Ä' | 'Á' | 'Ã' | 'Å' => 'A',
        'Ç' => 'C',
        'É' | 'È' | 'Ê' | 'Ë' => 'E',
        'Î' | 'Ï' | 'Í' | 'Ì' => 'I',
        'Ô' | 'Ö' | 'Ó' | 'Ò' | 'Õ' => 'O',
        'Ù' | 'Û' | 'Ü' | 'Ú' => 'U',
        'Ÿ' | 'Ý' => 'Y',
        'Ñ' => 'N',
        c => c,
    }
}

/// Libellé lisible pour l'affichage : « TOULOUSE LIDL » → « Toulouse Lidl ».
pub fn display(key: &str) -> String {
    key.split(' ')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c.flat_map(|x| x.to_lowercase())).collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_mutuel() {
        assert_eq!(key("PAIEMENT MOB 0511 TOULOUSE LIDL 0927 CARTE 1234"), "TOULOUSE LIDL");
        assert_eq!(key("PAIEMENT MOB 2909 WATTR 0495/ LIDL CARTE 1234"), "WATTR LIDL");
        assert_eq!(key("PAIEMENT CB 0808 JABBEKE TOTAL NB000724 J CARTE 1234"), "JABBEKE TOTAL J");
        assert_eq!(key("PAIEMENT MOB 3108 TOULOUSE SUMUP *RUSH CAF CARTE 1234"), "TOULOUSE SUMUP *RUSH CAF");
        assert_eq!(
            key("PRLV SEPA BASIC FIT FRANCE NO123456789-0102 20-09-2026 / 17-10-2026"),
            "PRLV BASIC FIT FRANCE"
        );
        assert_eq!(key("VIR INST JEAN DUPONT--MARTIN AB1C23456D789012"), "VIR JEAN DUPONT--MARTIN");
        assert_eq!(key("F COTIS EUROCOMPTE JEUNE"), "F COTIS EUROCOMPTE JEUNE");
    }

    #[test]
    fn revolut() {
        assert_eq!(key("Paypal *paiement 4x"), "PAYPAL *PAIEMENT");
        assert_eq!(key("Total"), "TOTAL");
        assert_eq!(key("To EUR MB:6257e349-6940-4bb2-b6b5-bfadf01d85bd"), "TO EUR");
        assert_eq!(
            key("VIR DE M JEAN DUPONT--MARTIN Payment from M Jean Dupont--martin"),
            "VIR DE M JEAN DUPONT--MARTIN"
        );
        assert_eq!(
            key("R-QT/2026/1111 MINIMES Avril 2026 Payment from Sarl Exemple"),
            "MINIMES SARL EXEMPLE"
        );
    }

    #[test]
    fn names() {
        assert_eq!(holder_name("M JEAN DUPONT--MARTIN").as_deref(), Some("JEAN DUPONT--MARTIN"));
        assert_eq!(holder_name("Jean Dupont--Martin").as_deref(), Some("JEAN DUPONT--MARTIN"));
        assert_eq!(holder_name("Compte courant"), None);
        assert_eq!(squash("M Jean Dupont--martin"), squash("JEAN DUPONT MARTIN"));
        assert_eq!(squash("JÉRÔME DUPONT--BÉCHU"), "JEROMEDUPONTBECHU");
        assert_eq!(holder_keys("JEAN DUPONT--MARTIN"), vec!["JEANDUPONTMARTIN".to_string(), "JEANDUPONT".to_string()]);
        assert_eq!(display("TOULOUSE LIDL"), "Toulouse Lidl");
    }
}
