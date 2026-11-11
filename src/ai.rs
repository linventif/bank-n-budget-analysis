//! Classification par un petit modèle de langage local, servi par Ollama (http://127.0.0.1:11434).
//! Rien ne sort de la machine : seuls les libellés sont envoyés au serveur Ollama local.

use crate::config::Ai as AiConfig;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

pub struct Client {
    http: reqwest::Client,
    cfg: AiConfig,
}

/// Une catégorie proposée au modèle.
pub struct Choice<'a> {
    pub name: &'a str,
    pub description: &'a str,
}

/// Une opération (en fait un marchand : toutes ses opérations de même sens) à classer.
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
font foi pour des marchands similaires. Si rien ne permet de trancher, choisis la catégorie « Autre… » adaptée avec \
une confiance basse. La confiance va de 0 (pur hasard) à 1 (certain).";

impl Client {
    pub fn new(cfg: AiConfig) -> Result<Self> {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(cfg.timeout_secs)).build()?;
        Ok(Self { http, cfg })
    }

    pub fn model(&self) -> &str {
        &self.cfg.model
    }

    pub fn batch_size(&self) -> usize {
        self.cfg.batch_size.max(1)
    }

    pub async fn health(&self) -> Health {
        #[derive(Deserialize)]
        struct Tags {
            models: Vec<Model>,
        }
        #[derive(Deserialize)]
        struct Model {
            name: String,
        }
        let url = format!("{}/api/tags", self.cfg.url);
        let tags = async {
            let r = self.http.get(&url).timeout(Duration::from_secs(3)).send().await?.error_for_status()?;
            r.json::<Tags>().await
        }
        .await;
        match tags {
            Ok(t) => {
                let models: Vec<String> = t.models.into_iter().map(|m| m.name).collect();
                let wanted = &self.cfg.model;
                let installed = models
                    .iter()
                    .any(|m| m == wanted || m.strip_suffix(":latest") == Some(wanted.as_str()));
                Health { reachable: true, model_installed: installed, model: wanted.clone(), models }
            }
            Err(_) => Health { reachable: false, model_installed: false, model: self.cfg.model.clone(), models: vec![] },
        }
    }

    /// Classe un lot d'opérations. `examples` : (libellé, catégorie) validés par l'utilisateur.
    pub async fn classify(
        &self,
        choices: &[Choice<'_>],
        examples: &[(String, String)],
        items: &[Item],
        direction: &str,
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
                        "required": ["i", "categorie", "confiance"]
                    }
                }
            },
            "required": ["resultats"]
        });

        let mut body = json!({
            "model": self.cfg.model,
            "stream": false,
            "format": schema,
            "keep_alive": "15m",
            "options": { "temperature": 0, "num_ctx": self.cfg.num_ctx },
            "messages": [
                { "role": "system", "content": SYSTEM },
                { "role": "user", "content": prompt }
            ]
        });
        // Les modèles « qui réfléchissent » (Qwen3…) sont bien plus lents sans apport ici.
        if self.cfg.disable_thinking {
            body["think"] = json!(false);
        }

        let mut resp = self.post_chat(&body).await;
        if let Err(e) = &resp {
            if format!("{e:#}").contains("think") {
                body.as_object_mut().unwrap().remove("think");
                resp = self.post_chat(&body).await;
            }
        }
        let content = resp?;

        #[derive(Deserialize)]
        struct Out {
            resultats: Vec<Answer>,
        }
        let out: Out = serde_json::from_str(&content)
            .with_context(|| format!("réponse du modèle illisible : {}", content.chars().take(300).collect::<String>()))?;
        Ok(out.resultats)
    }

    async fn post_chat(&self, body: &Value) -> Result<String> {
        let resp = self
            .http
            .post(format!("{}/api/chat", self.cfg.url))
            .json(body)
            .send()
            .await
            .context("Ollama injoignable")?;
        let status = resp.status();
        let v: Value = resp.json().await.context("réponse Ollama invalide")?;
        if !status.is_success() {
            bail!("Ollama HTTP {status} : {}", v.get("error").and_then(Value::as_str).unwrap_or("erreur inconnue"));
        }
        v["message"]["content"]
            .as_str()
            .map(str::to_string)
            .context("réponse Ollama sans contenu")
    }
}
