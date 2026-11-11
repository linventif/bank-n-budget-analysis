pub mod api;
pub mod html;
pub mod local;
pub mod public;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Erreur de handler : journalisée, puis affichée dans une page.
pub struct AppError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        tracing::error!("{:#}", self.0);
        let body = format!(
            "<h1>Erreur</h1><p class=\"error\">{}</p><p><a href=\"/\">Retour</a></p>",
            html::esc(&format!("{:#}", self.0))
        );
        (StatusCode::INTERNAL_SERVER_ERROR, html::page("Erreur", &body)).into_response()
    }
}

pub type HandlerResult<T> = Result<T, AppError>;
