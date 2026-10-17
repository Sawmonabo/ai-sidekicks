//! What the control plane's tests share: a fresh account file and a call through a router.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use rusqlite::Connection;
use sidekicks_control_plane::account_store::{AccountStore, open_account_file};
use tempfile::TempDir;
use tower_service::Service;

/// An account file in a folder of its own, removed with the folder.
pub(crate) struct AccountFile {
    /// The open file, as the relay shares it.
    pub(crate) connection: Arc<Mutex<Connection>>,
    _folder: TempDir,
}

/// A fresh account file with its schema built.
pub(crate) fn create_account_file() -> AccountFile {
    let folder = tempfile::tempdir().expect("the test can make a folder");
    let connection = open_account_file(&folder.path().join("account.sqlite"))
        .expect("a fresh account file opens");
    AccountFile {
        connection: Arc::new(Mutex::new(connection)),
        _folder: folder,
    }
}

impl AccountFile {
    /// How many requests the file holds counted.
    pub(crate) fn count_held_requests(&self) -> i64 {
        #[derive(serde::Deserialize)]
        struct Count {
            counted: i64,
        }
        let connection = self
            .connection
            .lock()
            .expect("no test panicked holding the file");
        let rows: Vec<Count> = connection
            .query("SELECT COUNT(*) AS counted FROM counted_requests", &[])
            .expect("the count reads");
        rows[0].counted
    }
}

/// Sends `request` through `router` and reads the answer's status, headers and JSON body.
pub(crate) async fn call(
    router: &Router,
    request: Request<Body>,
) -> (StatusCode, HeaderMap, serde_json::Value) {
    let response = router
        .clone()
        .call(request)
        .await
        .expect("a router never fails");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body reads");
    let body = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("a body is JSON")
    };
    (status, headers, body)
}
