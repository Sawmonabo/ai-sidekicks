//! The Apple app site association file, which lets the iPhone app make and use passkeys for the
//! control plane's host. It reads no store, so the Worker serves it without the account object.

use std::sync::Arc;

use axum::extract::{Extension, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::account::settings::SettingError;
use crate::server::router::{ControlPlaneRefusal, RequestId};

/// The app allowed to use passkeys for this host: `<team prefix>.<bundle id>`.
pub const APPLE_APP_IDENTIFIER: &str = "APPLE_APP_IDENTIFIER";

/// Where Apple reads the file: from the host itself, over HTTPS, with no redirect.
const APP_SITE_ASSOCIATION_PATH: &str = "/.well-known/apple-app-site-association";

/// Builds the route that serves the file for `apple_app_identifier`, the setting's value, or
/// fails it with the logged 500 when the setting is absent.
pub fn build_app_site_association_router(apple_app_identifier: Option<String>) -> Router {
    Router::new()
        .route(APP_SITE_ASSOCIATION_PATH, get(serve_app_site_association))
        .with_state(apple_app_identifier.map(Arc::<str>::from))
}

async fn serve_app_site_association(
    State(apple_app_identifier): State<Option<Arc<str>>>,
    request_id: Option<Extension<RequestId>>,
) -> Response {
    if let Some(app) = apple_app_identifier {
        return Json(json!({ "webcredentials": { "apps": [&*app] } })).into_response();
    }
    let request_id = request_id.map(|Extension(request_id)| request_id);
    ControlPlaneRefusal::refuse_internal_failure(
        request_id.as_ref(),
        &SettingError::Missing(APPLE_APP_IDENTIFIER),
    )
    .into_response()
}
