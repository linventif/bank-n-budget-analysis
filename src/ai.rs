//! Classification par un petit modèle de langage local. Deux fournisseurs :
//! - `openai` : toute API compatible OpenAI (vLLM, llama.cpp server…), ex. http://127.0.0.1:8000/v1 ;
//! - `ollama` : http://127.0.0.1:11434.
//!
//! Rien ne sort de la machine : seuls les libellés sont envoyés au serveur local.

use crate::config::Ai as AiConfig;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use futures::StreamExt;
use regex::Regex;
use std::sync::LazyLock;
use std::time::Duration;

/// Un élément complet de la réponse JSON compacte.
static ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\{"i":\d+,"categorie":"(?:[^"\\]|\\.)*","confiance":-?[0-9][0-9.eE+-]*\}"#).unwrap()
});

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    OpenAi,
    Ollama,
}

impl Provider {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "openai" | "vllm" | "llamacpp" | "llama.cpp" => Ok(Self::OpenAi),
            "ollama" => Ok(Self::Ollama),
            other => bail!("ai.provider inconnu : {other} (attendu : vllm/openai ou ollama)"),
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "vllm",
            Self::Ollama => "ollama",
        }
    }
}

pub struct Client {
    http: reqwest::Client,
    cfg: AiConfig,
    provider: Provider,
}

/// Une catégorie proposée au modèle.
pub struct Choice<'a> {
    pub name: &'a str,
    pub description: &'a str,
}

/// Un marchand (toutes ses opérations de même sens) à classer.
#[derive(Serialize)]
pub struct Item {
    pub i: usize,
    pub libelle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contrepartie: Option<String>,
    pub montant: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// Nombre d'opérations regroupées.
    pub nb: usize,
}

#[derive(Debug, Deserialize)]
pub struct Answer {
    pub i: usize,
    pub categorie: String,
    #[serde(default)]
    pub confiance: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct Health {
    pub provider: &'static str,
    pub url: String,
    pub reachable: bool,
    pub model_installed: bool,
    pub model: String,
    pub models: Vec<String>,
}

const SYSTEM: &str = "Tu classes les opérations bancaires d'un particulier français. \
Pour chaque opération, choisis la catégorie la plus probable parmi la liste fournie, d'après le libellé, \
la contrepartie, le type et le montant. Les libellés sont souvent abrégés : « PAIEMENT CB/MOB » = paiement par carte \
(suivi de la ville puis du commerce), « PRLV » = prélèvement, « VIR » = virement, « F COTIS » = frais de cotisation, \
« SUMUP » ou « SQ * » = petit commerçant (souvent café, bar ou restaurant). Utilise ta connaissance des enseignes \
(ex. LIDL = supermarché, SNCF = train, BASIC FIT = salle de sport). Les exemples déjà classés par l'utilisateur \
font foi pour des marchands similaires. Les catégories de virements internes et d'épargne ne concernent que \
les comptes du titulaire : un virement envoyé à une autre personne (nom ou prénom d'un tiers) ou reçu d'elle n'en est \
jamais un. Si rien ne permet de trancher, choisis la catégorie « Autre… » adaptée avec \
une confiance basse. La confiance va de 0 (pur hasard) à 1 (certain).";

impl Client {
    pub fn new(cfg: AiConfig) -> Result<Self> {
        let provider = Provider::parse(&cfg.provider)?;
        let http = reqwest::Client::builder().timeout(Duration::from_secs(cfg.timeout_secs)).build()?;
        Ok(Self { http, cfg, provider })
    }

    pub fn model(&self) -> &str {
        &self.cfg.model
    }

    pub fn batch_size(&self) -> usize {
        self.cfg.batch_size.max(1)
    }

    /// Lots envoyés en parallèle (vLLM regroupe les requêtes simultanées).
    pub fn concurrency(&self) -> usize {
        self.cfg.concurrency.clamp(1, 16)
    }

    pub fn setup_hint(&self) -> String {
        match self.provider {
            Provider::OpenAi => "lance ./scripts/vllm.sh start".into(),
            Provider::Ollama => format!("ollama pull {}", self.cfg.model),
        }
    }

    fn authed(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.cfg.api_key {
            Some(k) if !k.is_empty() => req.bearer_auth(k),
            _ => req,
        }
    }

    pub async fn health(&self) -> Health {
        let models: Result<Vec<String>> = async {
            match self.provider {
                Provider::OpenAi => {
                    #[derive(Deserialize)]
                    struct List {
                        data: Vec<M>,
                    }
                    #[derive(Deserialize)]
                    struct M {
                        id: String,
                    }
                    let r = self
                        .authed(self.http.get(format!("{}/models", self.cfg.url)))
                        .timeout(Duration::from_secs(3))
                        .send()
                        .await?
                        .error_for_status()?;
                    Ok(r.json::<List>().await?.data.into_iter().map(|m| m.id).collect())
                }
                Provider::Ollama => {
                    #[derive(Deserialize)]
                    struct Tags {
                        models: Vec<M>,
                    }
                    #[derive(Deserialize)]
                    struct M {
                        name: String,
                    }
                    let r = self
                        .http
                        .get(format!("{}/api/tags", self.cfg.url))
                        .timeout(Duration::from_secs(3))
                        .send()
                        .await?
                        .error_for_status()?;
                    Ok(r.json::<Tags>().await?.models.into_iter().map(|m| m.name).collect())
                }
            }
        }
        .await;
        let wanted = self.cfg.model.clone();
        let base = Health {
            provider: self.provider.label(),
            url: self.cfg.url.clone(),
            reachable: false,
            model_installed: false,
            model: wanted.clone(),
            models: vec![],
        };
        match models {
            Ok(models) => Health {
                reachable: true,
                model_installed: models
                    .iter()
                    .any(|m| m == &wanted || m.strip_suffix(":latest") == Some(wanted.as_str())),
                models,
                ..base
            },
            Err(_) => base,
        }
    }

    /// Classe un lot d'opérations. `examples` : (libellé, catégorie) validés par l'utilisateur.
    /// `on_item` est appelé pour chaque réponse dès qu'elle est connue (au fil de l'eau avec vLLM).
    pub async fn classify(
        &self,
        choices: &[Choice<'_>],
        examples: &[(String, String)],
        items: &[Item],
        direction: &str,
        on_item: &(dyn Fn(&Answer) + Sync),
    ) -> Result<Vec<Answer>> {
        let names: Vec<&str> = choices.iter().map(|c| c.name).collect();
        let mut prompt = String::from("Catégories possibles :\n");
        for c in choices {
            prompt += &format!("- {} : {}\n", c.name, c.description);
        }
        if !examples.is_empty() {
            prompt += "\nExemples déjà classés par l'utilisateur :\n";
            for (label, cat) in examples {
                prompt += &format!("- « {label} » → {cat}\n");
            }
        }
        prompt += &format!(
            "\nOpérations à classer ({direction}) :\n{}\n\nRéponds avec une entrée par opération, dans le champ « resultats ».",
            serde_json::to_string_pretty(items)?
        );

        // La sortie est contrainte côté serveur : une catégorie hors liste est impossible.
        let schema = json!({
            "type": "object",
            "properties": {
                "resultats": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "i": { "type": "integer" },
                            "categorie": { "type": "string", "enum": names },
                            "confiance": { "type": "number" }
                        },
                        "required": ["i", "categorie", "confiance"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["resultats"],
            "additionalProperties": false
        });
        let messages = json!([
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": prompt }
        ]);

        let mut reported = std::collections::HashSet::new();
        let content = match self.provider {
            Provider::OpenAi => self.chat_openai_stream(&messages, &schema, items.len(), on_item, &mut reported).await?,
            Provider::Ollama => self.chat_ollama(&messages, &schema).await?,
        };

        #[derive(Deserialize)]
        struct Out {
            resultats: Vec<Answer>,
        }
        let out: Out = serde_json::from_str(content.trim())
            .with_context(|| format!("réponse du modèle illisible : {}", content.chars().take(300).collect::<String>()))?;
        // Réponses pas encore signalées (Ollama, ou format inattendu pendant le flux).
        for a in out.resultats.iter().filter(|a| !reported.contains(&a.i)) {
            on_item(a);
        }
        Ok(out.resultats)
    }

    /// Requête en flux (SSE) : chaque objet {"i":…,"categorie":…,"confiance":…} complet est
    /// remonté immédiatement, ce qui permet d'afficher l'avancement opération par opération.
    async fn chat_openai_stream(
        &self,
        messages: &Value,
        schema: &Value,
        n_items: usize,
        on_item: &(dyn Fn(&Answer) + Sync),
        reported: &mut std::collections::HashSet<usize>,
    ) -> Result<String> {
        let mut body = json!({
            "model": self.cfg.model,
            "messages": messages,
            "temperature": 0,
            "stream": true,
            // ~25 jetons par réponse en JSON compact, plus une marge.
            "max_tokens": 256 + n_items * 60,
            "response_format": {
                "type": "json_schema",
                "json_schema": { "name": "classement", "schema": schema, "strict": true }
            }
        });
        // Qwen3 & co. : pas de « réflexion », bien plus lente et inutile ici (paramètre propre à vLLM).
        if self.cfg.disable_thinking {
            body["chat_template_kwargs"] = json!({ "enable_thinking": false });
        }
        let url = format!("{}/chat/completions", self.cfg.url);
        let mut resp = self.open_stream(&url, &body).await;
        if let Err(e) = &resp {
            if format!("{e:#}").contains("chat_template_kwargs") {
                body.as_object_mut().unwrap().remove("chat_template_kwargs");
                resp = self.open_stream(&url, &body).await;
            }
        }
        let mut stream = resp?.bytes_stream();

        let mut buf: Vec<u8> = Vec::new();
        let mut content = String::new();
        let mut scanned = 0usize;
        let mut truncated = false;
        while let Some(chunk) = stream.next().await {
            buf.extend_from_slice(&chunk.context("flux interrompu")?);
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
                if data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(err) = v.get("error") {
                    bail!("serveur IA : {}", err["message"].as_str().unwrap_or("erreur inconnue"));
                }
                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                    content.push_str(delta);
                }
                if v["choices"][0]["finish_reason"] == "length" {
                    truncated = true;
                }
            }
            // Objets terminés depuis le dernier passage.
            for m in ITEM.find_iter(&content[scanned..]) {
                if let Ok(a) = serde_json::from_str::<Answer>(m.as_str()) {
                    if reported.insert(a.i) {
                        on_item(&a);
                    }
                }
            }
            if let Some(last) = ITEM.find_iter(&content[scanned..]).last() {
                scanned += last.end();
            }
        }
        if truncated {
            bail!("réponse tronquée (max_tokens atteint) : réduis ai.batch_size");
        }
        Ok(content)
    }

    async fn open_stream(&self, url: &str, body: &Value) -> Result<reqwest::Response> {
        let resp = self
            .authed(self.http.post(url).json(body))
            .send()
            .await
            .with_context(|| format!("serveur IA injoignable ({})", self.cfg.url))?;
        let status = resp.status();
        if !status.is_success() {
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            let msg = v["error"]["message"].as_str().or(v["message"].as_str()).unwrap_or("erreur inconnue");
            bail!("serveur IA HTTP {status} : {msg}");
        }
        Ok(resp)
    }

    async fn chat_ollama(&self, messages: &Value, schema: &Value) -> Result<String> {
        let mut body = json!({
            "model": self.cfg.model,
            "stream": false,
            "format": schema,
            "keep_alive": "15m",
            "options": { "temperature": 0, "num_ctx": self.cfg.num_ctx },
            "messages": messages
        });
        if self.cfg.disable_thinking {
            body["think"] = json!(false);
        }
        let url = format!("{}/api/chat", self.cfg.url);
        let mut resp = self.post(&url, &body).await;
        if let Err(e) = &resp {
            if format!("{e:#}").contains("think") {
                body.as_object_mut().unwrap().remove("think");
                resp = self.post(&url, &body).await;
            }
        }
        resp?["message"]["content"]
            .as_str()
            .map(str::to_string)
            .context("réponse Ollama sans contenu")
    }

    async fn post(&self, url: &str, body: &Value) -> Result<Value> {
        let resp = self
            .authed(self.http.post(url).json(body))
            .send()
            .await
            .with_context(|| format!("serveur IA injoignable ({})", self.cfg.url))?;
        let status = resp.status();
        let v: Value = resp.json().await.context("réponse du serveur IA invalide")?;
        if !status.is_success() {
            // OpenAI : {"error": {"message"}} ou {"message"} ; Ollama : {"error": "…"}.
            let msg = v["error"]["message"]
                .as_str()
                .or(v["error"].as_str())
                .or(v["message"].as_str())
                .unwrap_or("erreur inconnue");
            bail!("serveur IA HTTP {status} : {msg}");
        }
        Ok(v)
    }
}
