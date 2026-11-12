//! Client minimal pour l'API Enable Banking (https://enablebanking.com/docs/api/reference/).

use anyhow::{Context, Result};
use chrono::NaiveDate;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::de::{DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::time::Duration;

const API: &str = "https://api.enablebanking.com";

pub struct Client {
    http: reqwest::Client,
    app_id: String,
    key: EncodingKey,
}

#[derive(Serialize)]
struct Claims {
    iss: &'static str,
    aud: &'static str,
    iat: i64,
    exp: i64,
}

/// Erreur renvoyée par l'API (`{"message", "code", "error", "detail"}`).
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub error: Option<String>,
    pub message: String,
    pub detail: Option<Value>,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Enable Banking HTTP {}", self.status)?;
        if let Some(e) = &self.error {
            write!(f, " {e}")?;
        }
        write!(f, " : {}", self.message)?;
        if let Some(d) = &self.detail {
            write!(f, " ({d})")?;
        }
        Ok(())
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    /// La session n'est plus utilisable : il faut réautoriser la banque.
    /// Le compte n'existe plus (ou plus accessible) chez la banque, ex. pocket Revolut supprimée.
    pub fn is_account_gone(&self) -> bool {
        matches!(self.error.as_deref(), Some("ACCOUNT_DOES_NOT_EXIST" | "ASPSP_ACCOUNT_NOT_ACCESSIBLE"))
    }

    pub fn is_session_dead(&self) -> bool {
        matches!(
            self.error.as_deref(),
            Some("EXPIRED_SESSION" | "REVOKED_SESSION" | "CLOSED_SESSION" | "SESSION_DOES_NOT_EXIST")
        )
    }
}

impl Client {
    pub fn new(app_id: String, private_key_pem: &[u8]) -> Result<Self> {
        let key = EncodingKey::from_rsa_pem(private_key_pem).context("clé privée RSA invalide")?;
        let http = reqwest::Client::builder()
            .user_agent(concat!("bks/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(90))
            .build()?;
        Ok(Self { http, app_id, key })
    }

    fn jwt(&self) -> Result<String> {
        let mut header = Header::new(Algorithm::RS256);
        header.typ = Some("JWT".into());
        header.kid = Some(self.app_id.clone());
        let iat = chrono::Utc::now().timestamp();
        let claims = Claims { iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + 3600 };
        jsonwebtoken::encode(&header, &claims, &self.key).context("signature du JWT")
    }

    async fn send<T: DeserializeOwned>(&self, req: reqwest::RequestBuilder) -> Result<T> {
        let resp = req.bearer_auth(self.jwt()?).send().await.context("appel Enable Banking")?;
        let status = resp.status();
        let body = resp.bytes().await?;
        if !status.is_success() {
            #[derive(Deserialize)]
            struct ErrBody {
                message: Option<String>,
                error: Option<String>,
                detail: Option<Value>,
            }
            let parsed: Option<ErrBody> = serde_json::from_slice(&body).ok();
            let (message, error, detail) = match parsed {
                Some(b) => (b.message.unwrap_or_default(), b.error, b.detail),
                None => (String::from_utf8_lossy(&body).chars().take(300).collect(), None, None),
            };
            return Err(ApiError { status: status.as_u16(), error, message, detail }.into());
        }
        serde_json::from_slice(&body).context("réponse Enable Banking inattendue")
    }

    pub async fn aspsps(&self, country: &str) -> Result<Vec<Aspsp>> {
        #[derive(Deserialize)]
        struct R {
            aspsps: Vec<Aspsp>,
        }
        let r: R = self
            .send(self.http.get(format!("{API}/aspsps")).query(&[("country", country), ("psu_type", "personal")]))
            .await?;
        Ok(r.aspsps)
    }

    pub async fn start_auth(&self, req: &StartAuth<'_>) -> Result<StartAuthResponse> {
        self.send(self.http.post(format!("{API}/auth")).json(req)).await
    }

    pub async fn create_session(&self, code: &str) -> Result<Session> {
        self.send(self.http.post(format!("{API}/sessions")).json(&serde_json::json!({ "code": code })))
            .await
    }

    pub async fn balances(&self, account_uid: &str) -> Result<Vec<Balance>> {
        #[derive(Deserialize)]
        struct R {
            balances: Vec<Balance>,
        }
        let r: R = self.send(self.http.get(format!("{API}/accounts/{account_uid}/balances"))).await?;
        Ok(r.balances)
    }

    /// Une page de transactions. Sans `date_from`, on demande l'historique le plus long possible.
    pub async fn transactions_page(
        &self,
        account_uid: &str,
        date_from: Option<NaiveDate>,
        continuation_key: Option<&str>,
    ) -> Result<TransactionsPage> {
        let mut q: Vec<(&str, String)> = Vec::new();
        match date_from {
            Some(d) => q.push(("date_from", d.format("%Y-%m-%d").to_string())),
            None => q.push(("strategy", "longest".into())),
        }
        if let Some(k) = continuation_key {
            q.push(("continuation_key", k.to_string()));
        }
        self.send(self.http.get(format!("{API}/accounts/{account_uid}/transactions")).query(&q)).await
    }
}

// ---------- Types ----------

#[derive(Debug, Clone, Deserialize)]
pub struct Aspsp {
    pub name: String,
    pub country: String,
    /// En secondes.
    pub maximum_consent_validity: Option<i64>,
    #[serde(default)]
    pub beta: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AspspRef {
    pub name: String,
    pub country: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Access {
    /// RFC 3339.
    pub valid_until: String,
}

#[derive(Serialize)]
pub struct StartAuth<'a> {
    pub access: Access,
    pub aspsp: AspspRef,
    pub state: &'a str,
    pub redirect_url: &'a str,
    pub psu_type: &'a str,
    pub language: &'a str,
}

#[derive(Deserialize)]
pub struct StartAuthResponse {
    pub url: String,
}

#[derive(Deserialize)]
pub struct Session {
    pub session_id: String,
    /// Gardés bruts pour pouvoir les stocker tels quels ; voir [`Account`].
    pub accounts: Vec<Value>,
    pub aspsp: AspspRef,
    pub access: Access,
}

#[derive(Debug, Deserialize)]
pub struct Account {
    pub uid: Option<String>,
    /// Stable d'une session à l'autre (contrairement à `uid`).
    pub identification_hash: String,
    pub account_id: Option<AccountId>,
    pub name: Option<String>,
    pub details: Option<String>,
    pub product: Option<String>,
    pub currency: String,
    pub cash_account_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AccountId {
    pub iban: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Amount {
    pub currency: String,
    #[serde(deserialize_with = "string_or_number")]
    pub amount: String,
}

#[derive(Debug, Deserialize)]
pub struct Balance {
    pub balance_amount: Amount,
    pub balance_type: String,
    pub reference_date: Option<String>,
}

#[derive(Deserialize)]
pub struct TransactionsPage {
    pub transactions: Vec<Value>,
    pub continuation_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Transaction {
    pub entry_reference: Option<String>,
    pub transaction_id: Option<String>,
    pub merchant_category_code: Option<String>,
    pub transaction_amount: Amount,
    pub creditor: Option<Party>,
    pub debtor: Option<Party>,
    pub bank_transaction_code: Option<BankTransactionCode>,
    /// CRDT ou DBIT.
    pub credit_debit_indicator: String,
    /// BOOK, PDNG, …
    pub status: String,
    pub booking_date: Option<String>,
    pub value_date: Option<String>,
    pub transaction_date: Option<String>,
    pub remittance_information: Option<Vec<String>>,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Party {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BankTransactionCode {
    pub description: Option<String>,
}

fn string_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    match Value::deserialize(d)? {
        Value::String(s) => Ok(s),
        Value::Number(n) => Ok(n.to_string()),
        other => Err(serde::de::Error::custom(format!("montant invalide : {other}"))),
    }
}
