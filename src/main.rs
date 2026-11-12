mod ai;
mod auth;
mod budget;
mod categorize;
mod config;
mod db;
mod eb;
mod merchant;
mod suggest;
mod sync;
mod web;

use anyhow::{Context, Result};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub cfg: config::Config,
    /// Verrou synchrone : ne jamais le garder à travers un `.await`.
    pub db: Mutex<rusqlite::Connection>,
    pub eb: Option<eb::Client>,
    pub syncing: AtomicBool,
    pub last_sync_message: Mutex<Option<String>>,
    pub aspsp_cache: tokio::sync::Mutex<Option<(Instant, Vec<eb::Aspsp>)>>,
    pub ai: Option<ai::Client>,
    pub classifying: AtomicBool,
    /// Demande d'arrêt de la classification en cours.
    pub ai_cancel: AtomicBool,
    pub ai_progress: Mutex<categorize::AiProgress>,
    pub auth: auth::Auth,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("bks=info")))
        .init();

    let cfg = config::Config::load()?;
    let mut conn = db::open(&cfg.server.database)?;
    let n = categorize::backfill_merchants(&conn)?;
    let stats = categorize::apply_deterministic(&mut conn)?;
    tracing::info!(merchants_backfilled = n, ?stats, "catégorisation au démarrage");
    if let Some(dir) = cfg.server.database.parent() {
        match budget::import_seed(&mut conn, dir) {
            Ok(Some(name)) => tracing::info!("budget « {name} » importé depuis budget-seed.json"),
            Ok(None) => {}
            Err(e) => tracing::warn!("budget-seed.json non importé : {e:#}"),
        }
    }

    let eb = match &cfg.enable_banking {
        Some(e) => {
            let pem = std::fs::read(&e.private_key)
                .with_context(|| format!("lecture de la clé privée {}", e.private_key.display()))?;
            Some(eb::Client::new(e.app_id.clone(), &pem)?)
        }
        None => {
            tracing::warn!("section [enable_banking] absente : seules les pages publiques fonctionnent");
            None
        }
    };

    let public_listener = tokio::net::TcpListener::bind(cfg.server.public_addr)
        .await
        .with_context(|| format!("écoute sur {}", cfg.server.public_addr))?;
    let local_listener = tokio::net::TcpListener::bind(cfg.server.local_addr)
        .await
        .with_context(|| format!("écoute sur {}", cfg.server.local_addr))?;
    tracing::info!(
        "public (tunnel) : http://{} → {} | tableau de bord : http://localhost:{}",
        cfg.server.public_addr,
        cfg.server.public_url,
        cfg.server.local_addr.port()
    );
    tracing::info!("redirect URL à déclarer chez Enable Banking : {}", cfg.redirect_url());

    let ai = if cfg.ai.enabled { Some(ai::Client::new(cfg.ai.clone())?) } else { None };
    let auth = auth::Auth::new(&cfg.server.public_url)?;
    if cfg.server.public_dashboard {
        tracing::info!("tableau de bord public sur {} (connexion par passkey)", cfg.server.public_url);
    }

    let state = Arc::new(AppState {
        cfg,
        db: Mutex::new(conn),
        eb,
        syncing: AtomicBool::new(false),
        last_sync_message: Mutex::new(None),
        aspsp_cache: tokio::sync::Mutex::new(None),
        ai,
        classifying: AtomicBool::new(false),
        ai_cancel: AtomicBool::new(false),
        ai_progress: Mutex::new(categorize::AiProgress::default()),
        auth,
    });

    if let Some(eb) = &state.cfg.enable_banking {
        sync::schedule(state.clone(), eb.auto_sync_hours);
    }
    let public = axum::serve(public_listener, web::public::router(state.clone())).with_graceful_shutdown(shutdown());
    let local = axum::serve(local_listener, web::local::router(state)).with_graceful_shutdown(shutdown());
    tokio::try_join!(async { public.await }, async { local.await })?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}
