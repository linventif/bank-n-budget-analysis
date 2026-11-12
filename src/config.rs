use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct Config {
    pub server: Server,
    #[serde(default)]
    pub legal: Legal,
    /// Absent tant que l'application Enable Banking n'est pas enregistrée :
    /// le serveur démarre quand même (pages publiques /terms et /privacy).
    pub enable_banking: Option<EnableBanking>,
    #[serde(default)]
    pub ai: Ai,
    #[serde(default)]
    pub market: Market,
}

/// Cotations : FRED (sans clé) pour les indices, Alpha Vantage (clé gratuite) pour les actions.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct Market {
    pub alphavantage_key: Option<String>,
    /// Clé de l'API officielle FRED (gratuite) : https://fred.stlouisfed.org/docs/api/api_key.html
    pub fred_key: Option<String>,
}

/// Modèle local (vLLM ou toute API compatible OpenAI, ou Ollama) pour classer les opérations.
#[derive(Debug, Deserialize, Clone)]
#[serde(default)]
pub struct Ai {
    pub enabled: bool,
    /// "vllm" (API compatible OpenAI) ou "ollama".
    pub provider: String,
    /// vLLM : http://127.0.0.1:8000/v1 ; Ollama : http://127.0.0.1:11434
    pub url: String,
    pub model: String,
    pub api_key: Option<String>,
    /// Nombre de marchands envoyés par requête.
    pub batch_size: usize,
    /// Requêtes simultanées (vLLM les traite en lot).
    pub concurrency: usize,
    /// Ollama uniquement.
    pub num_ctx: u32,
    pub timeout_secs: u64,
    pub disable_thinking: bool,
}

impl Default for Ai {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: "vllm".into(),
            url: "http://127.0.0.1:8000/v1".into(),
            model: "Qwen/Qwen3-4B-AWQ".into(),
            api_key: None,
            batch_size: 12,
            concurrency: 2,
            num_ctx: 8192,
            timeout_secs: 600,
            disable_thinking: true,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Server {
    /// Écoute exposée via le tunnel Cloudflare : uniquement /terms, /privacy, /callback.
    #[serde(default = "default_public_addr")]
    pub public_addr: SocketAddr,
    /// Interface privée (tableau de bord). Ne jamais la mettre derrière le tunnel.
    #[serde(default = "default_local_addr")]
    pub local_addr: SocketAddr,
    /// URL publique du tunnel, ex. https://bks.example.com
    pub public_url: String,
    #[serde(default = "default_database")]
    pub database: PathBuf,
    /// Frontend compilé (Solid) servi sur l'interface privée.
    #[serde(default = "default_web_dir")]
    pub web_dir: PathBuf,
    /// Tableau de bord accessible via le tunnel, derrière une connexion par passkey.
    #[serde(default = "default_true")]
    pub public_dashboard: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Default)]
pub struct Legal {
    pub contact_email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EnableBanking {
    /// Identifiant de l'application (= nom du fichier .pem téléchargé).
    pub app_id: String,
    pub private_key: PathBuf,
    /// Pays dont les banques sont proposées. Une banque doit être autorisée via le même
    /// pays que celui choisi au moment du « linking » (ex. Revolut est lié via FI).
    #[serde(default = "default_countries")]
    pub countries: Vec<String>,
    /// Durée de consentement demandée (plafonnée par la banque, souvent 180 j).
    #[serde(default = "default_consent_days")]
    pub consent_days: i64,
    /// Synchro automatique toutes les N heures (0 = désactivée). Les banques limitent
    /// souvent à 4 récupérations automatiques par jour : 8 h en laisse une pour le manuel.
    #[serde(default = "default_auto_sync_hours")]
    pub auto_sync_hours: u64,
}

fn default_public_addr() -> SocketAddr {
    "127.0.0.1:9889".parse().unwrap()
}
fn default_local_addr() -> SocketAddr {
    "127.0.0.1:9890".parse().unwrap()
}
fn default_database() -> PathBuf {
    "data/bank.db".into()
}
fn default_web_dir() -> PathBuf {
    "web/dist".into()
}
fn default_countries() -> Vec<String> {
    vec!["FR".into()]
}
fn default_auto_sync_hours() -> u64 {
    8
}
fn default_consent_days() -> i64 {
    180
}

impl Config {
    pub fn load() -> Result<Self> {
        let path = std::env::var("BKS_CONFIG").unwrap_or_else(|_| "config.toml".into());
        let raw = std::fs::read_to_string(&path).with_context(|| {
            format!("lecture de {path} impossible (copie config.example.toml vers config.toml)")
        })?;
        let mut cfg: Config = toml::from_str(&raw).with_context(|| format!("{path} invalide"))?;

        cfg.server.public_url = cfg.server.public_url.trim_end_matches('/').to_string();
        // http://localhost n'est admis que pour les tests (contexte sécurisé pour les navigateurs).
        let local_http = cfg.server.public_url.starts_with("http://localhost:") || cfg.server.public_url.starts_with("http://127.0.0.1:");
        if !cfg.server.public_url.starts_with("https://") && !local_http {
            bail!("server.public_url doit commencer par https://");
        }
        if !cfg.server.public_addr.ip().is_loopback() || !cfg.server.local_addr.ip().is_loopback() {
            bail!("public_addr et local_addr doivent écouter sur 127.0.0.1 (le tunnel s'occupe de l'exposition)");
        }
        if cfg.server.public_addr.port() == cfg.server.local_addr.port() {
            bail!("public_addr et local_addr doivent utiliser des ports différents");
        }
        cfg.server.database = expand_home(&cfg.server.database);
        cfg.server.web_dir = expand_home(&cfg.server.web_dir);
        cfg.ai.url = cfg.ai.url.trim_end_matches('/').to_string();
        if let Some(eb) = cfg.enable_banking.as_mut() {
            eb.private_key = expand_home(&eb.private_key);
            for c in eb.countries.iter_mut() {
                *c = c.trim().to_uppercase();
            }
            eb.countries.dedup();
            if eb.countries.is_empty() {
                bail!("enable_banking.countries ne peut pas être vide");
            }
        }
        Ok(cfg)
    }

    pub fn redirect_url(&self) -> String {
        format!("{}/callback", self.server.public_url)
    }
}

fn expand_home(p: &Path) -> PathBuf {
    match (p.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => p.to_path_buf(),
    }
}
