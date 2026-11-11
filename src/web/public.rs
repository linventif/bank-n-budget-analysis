//! Routes exposées sur Internet via le tunnel Cloudflare.
//! Rien ici ne doit afficher de donnée bancaire.

use super::html::{esc, page};
use super::{AppError, HandlerResult};
use crate::{AppState, db, sync};
use axum::Router;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use std::sync::Arc;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(home))
        .route("/terms", get(terms))
        .route("/privacy", get(privacy))
        .route("/callback", get(callback))
        .route("/health", get(|| async { "ok" }))
        .route("/robots.txt", get(|| async { ([(header::CONTENT_TYPE, "text/plain")], "User-agent: *\nDisallow: /\n") }))
        .with_state(state)
}

async fn home() -> Html<String> {
    page(
        "bks",
        "<h1>bks</h1><p>Application personnelle et privée de suivi de comptes bancaires. \
         Aucune inscription n'est possible.</p>\
         <p><a href=\"/terms\">Conditions d'utilisation</a> · <a href=\"/privacy\">Politique de confidentialité</a></p>",
    )
}

fn contact(state: &AppState) -> String {
    match &state.cfg.legal.contact_email {
        Some(m) => format!("<a href=\"mailto:{0}\">{0}</a>", esc(m)),
        None => "le propriétaire du domaine".into(),
    }
}

async fn terms(State(state): State<Arc<AppState>>) -> Html<String> {
    let body = format!(
        "<h1>Conditions d'utilisation</h1>\
         <p class=\"muted\">Dernière mise à jour : 11 novembre 2026</p>\
         <h2>Objet</h2>\
         <p>bks est une application personnelle, non commerciale, utilisée par une seule personne — son propriétaire — \
         pour consulter et catégoriser ses propres comptes bancaires. Elle n'est pas proposée au public et \
         aucune inscription n'est possible.</p>\
         <h2>Accès aux comptes</h2>\
         <p>L'accès aux données bancaires passe par Enable Banking Oy, prestataire de services d'information sur les comptes \
         agréé au titre de la directive DSP2. Il n'a lieu qu'avec le consentement explicite du titulaire des comptes, \
         donné auprès de sa banque, et peut être révoqué à tout moment auprès de la banque ou d'Enable Banking.</p>\
         <p>L'application ne fait que lire des données (soldes et opérations) : elle n'initie aucun paiement.</p>\
         <h2>Responsabilité</h2>\
         <p>L'application est fournie en l'état, sans garantie, pour l'usage exclusif de son propriétaire.</p>\
         <h2>Contact</h2><p>{}</p>\
         <p><a href=\"/privacy\">Politique de confidentialité</a></p>",
        contact(&state)
    );
    page("Conditions d'utilisation", &body)
}

async fn privacy(State(state): State<Arc<AppState>>) -> Html<String> {
    let body = format!(
        "<h1>Politique de confidentialité</h1>\
         <p class=\"muted\">Dernière mise à jour : 11 novembre 2026</p>\
         <h2>Qui est concerné</h2>\
         <p>bks est utilisée uniquement par son propriétaire, pour ses propres comptes. \
         Le responsable du traitement et la personne concernée sont donc la même personne.</p>\
         <h2>Données traitées</h2>\
         <ul><li>informations sur les comptes autorisés (intitulé, IBAN, devise) ;</li>\
         <li>soldes ;</li>\
         <li>opérations (date, montant, libellé, contrepartie).</li></ul>\
         <p>Ces données sont obtenues via Enable Banking Oy, uniquement pour les comptes explicitement autorisés \
         par leur titulaire.</p>\
         <h2>Finalité</h2>\
         <p>Suivi personnel du budget : affichage des soldes, historique et classement des dépenses.</p>\
         <h2>Stockage et partage</h2>\
         <p>Les données sont stockées localement, sur la machine du propriétaire. Elles ne sont ni vendues, \
         ni partagées, ni transmises à des tiers autres qu'Enable Banking et la banque concernée, \
         strictement pour le fonctionnement du service.</p>\
         <h2>Cookies et traçage</h2><p>Aucun cookie, aucun outil de mesure d'audience.</p>\
         <h2>Durée et droits</h2>\
         <p>Les données sont conservées tant que le propriétaire utilise l'application. Le consentement d'accès \
         aux comptes expire automatiquement (180 jours au plus) et peut être révoqué à tout moment. \
         Les données locales peuvent être supprimées à tout moment.</p>\
         <h2>Contact</h2><p>{}</p>\
         <p><a href=\"/terms\">Conditions d'utilisation</a></p>",
        contact(&state)
    );
    page("Politique de confidentialité", &body)
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Retour de la banque après autorisation. Le `state` (usage unique, 1 h) prouve que
/// l'autorisation a été lancée depuis le tableau de bord local.
async fn callback(State(app): State<Arc<AppState>>, Query(q): Query<CallbackQuery>) -> HandlerResult<Response> {
    let bad = |msg: &str| (StatusCode::BAD_REQUEST, page("Requête invalide", &format!("<h1>Requête invalide</h1><p>{}</p>", esc(msg)))).into_response();

    let Some(state) = q.state.as_deref() else { return Ok(bad("Paramètre state manquant.")) };
    let Some(aspsp) = db::take_pending(&app.db.lock().unwrap(), state)? else {
        return Ok(bad("Autorisation inconnue ou expirée. Relance la connexion depuis le tableau de bord."));
    };

    if let Some(err) = q.error.as_deref() {
        let desc = q.error_description.as_deref().unwrap_or("");
        tracing::warn!(aspsp, err, desc, "autorisation refusée");
        let body = format!(
            "<h1>Autorisation non accordée</h1><p>{} : {} {}</p>{}",
            esc(&aspsp),
            esc(err),
            esc(desc),
            back_link(&app)
        );
        return Ok((StatusCode::BAD_REQUEST, page("Autorisation refusée", &body)).into_response());
    }

    let Some(code) = q.code.as_deref() else { return Ok(bad("Paramètre code manquant.")) };
    let Some(client) = app.eb.as_ref() else {
        return Err(AppError::from(anyhow::anyhow!("Enable Banking n'est pas configuré")));
    };

    let session = client.create_session(code).await?;
    let n = sync::store_session(&mut app.db.lock().unwrap(), &session)?;
    tracing::info!(aspsp = session.aspsp.name, accounts = n, "nouvelle session autorisée");

    // L'historique complet n'est souvent disponible que juste après l'autorisation : on synchronise tout de suite.
    sync::spawn(app.clone());

    let warn = if n == 0 {
        "<p class=\"warn\">Aucun compte renvoyé. En mode restreint, seuls les comptes liés dans le panneau \
         Enable Banking (« Activate by linking accounts ») sont accessibles.</p>"
    } else {
        ""
    };
    let body = format!(
        "<h1>Banque connectée</h1><p>{} : {n} compte(s) autorisé(s), accès valable jusqu'au {}.</p>{warn}\
         <p>La synchronisation a démarré.</p>{}",
        esc(&session.aspsp.name),
        esc(session.access.valid_until.get(..10).unwrap_or(&session.access.valid_until)),
        back_link(&app)
    );
    Ok(page("Banque connectée", &body).into_response())
}

fn back_link(app: &AppState) -> String {
    format!(
        "<p><a href=\"http://localhost:{0}/\">Retour au tableau de bord (localhost:{0})</a></p>",
        app.cfg.server.local_addr.port()
    )
}
