//! The check in front of the tool servers on the daemon's listener: a request reaches rmcp only
//! when the live spawn entry its path names admits its secret, and an `Mcp-Session-Id` it carries
//! was minted on that same entry or is held by no one. The secret is checked on every request, so
//! a replaced or dropped spawn is refused at once, and each MCP session is closed when the spawn it
//! was minted for ends.

use std::error::Error;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse as _, Response};
use rmcp::transport::common::http_header::HEADER_SESSION_ID;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{SessionId, SessionManager as _};
use tokio_util::sync::CancellationToken;

use crate::tools::entries::{ToolServerEntries, ToolServerEntry};
use crate::tools::server::ToolServerPath;

/// What a request no live spawn admits is answered with, beside a 401 that carries no
/// `WWW-Authenticate`, so a provider reads a failed call and never starts a sign-in.
const NOT_ADMITTED: &str = "No live session admits this request here.";

/// The entries every request is admitted against, and the MCP sessions rmcp keeps for them.
pub(super) struct ToolServerAdmission {
    /// Every live spawn's entry.
    entries: Arc<ToolServerEntries>,
    /// rmcp's sessions, which reap no idle session, so an ended spawn's are closed here.
    sessions: Arc<LocalSessionManager>,
    /// The daemon's stop, whose child each admitted session's close token is.
    stop: CancellationToken,
}

impl ToolServerAdmission {
    /// An admission over `entries`, closing an ended spawn's sessions in `sessions`; the wait on
    /// each session ends at `stop` too.
    pub(super) fn new(
        entries: Arc<ToolServerEntries>,
        sessions: Arc<LocalSessionManager>,
        stop: CancellationToken,
    ) -> Self {
        Self {
            entries,
            sessions,
            stop,
        }
    }

    // Whether rmcp holds no session `mcp_session`, as for one a client kept across a restart of the
    // daemon.
    async fn is_unheld_session(&self, mcp_session: &str) -> bool {
        matches!(
            self.sessions
                .has_session(&SessionId::from(mcp_session.to_owned()))
                .await,
            Ok(false)
        )
    }

    // Admits `mcp_session`, which rmcp just minted, for `entry`'s spawn alone, and closes it once
    // that spawn ends; the wait holds no timer, and ends with nothing to close once the client
    // closed the session or the daemon stops.
    fn keep_for_spawn(&self, entry: Arc<ToolServerEntry>, mcp_session: String) {
        let closed = self.stop.child_token();
        entry.admit_mcp_session(mcp_session.clone(), closed.clone());
        let sessions = Arc::clone(&self.sessions);
        tokio::spawn(async move {
            tokio::select! {
                () = entry.ended() => {}
                () = closed.cancelled() => return,
            }
            let mcp_session = SessionId::from(mcp_session);
            if let Err(error) = sessions.close_session(&mcp_session).await {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "an ended spawn's MCP session did not close"
                );
            }
        });
    }
}

/// Passes `request` on only when the live entry its path names admits its secret and any
/// `Mcp-Session-Id` it carries is that entry's or held by no one, which rmcp answers 404 so the
/// client opens a new session; a refusal is 401 with no `WWW-Authenticate`, and a path naming no
/// tool server is 404. A session rmcp mints on the way back is admitted for that entry alone, and
/// one its client closes is forgotten.
pub(super) async fn admit(
    State(admission): State<Arc<ToolServerAdmission>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(path) = ToolServerPath::parse(request.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let authorization = request
        .headers()
        .get(AUTHORIZATION)
        .map(HeaderValue::as_bytes);
    let Some(entry) = admission.entries.admitted(&path, authorization) else {
        return refusal();
    };
    let mcp_session = match request.headers().get(HEADER_SESSION_ID) {
        None => None,
        Some(value) => {
            let Ok(mcp_session) = value.to_str() else {
                return refusal();
            };
            if entry.admits_mcp_session(mcp_session) {
                Some(mcp_session.to_owned())
            } else if admission.is_unheld_session(mcp_session).await {
                None
            } else {
                return refusal();
            }
        }
    };
    let is_close = request.method() == Method::DELETE;
    let response = next.run(request).await;
    match mcp_session {
        Some(mcp_session) if is_close && response.status().is_success() => {
            entry.forget_mcp_session(&mcp_session);
        }
        Some(_) => {}
        None => {
            if let Some(minted) = response
                .headers()
                .get(HEADER_SESSION_ID)
                .and_then(|value| value.to_str().ok())
            {
                admission.keep_for_spawn(entry, minted.to_owned());
            }
        }
    }
    response
}

// The answer to a request no live entry admits.
fn refusal() -> Response {
    (StatusCode::UNAUTHORIZED, NOT_ADMITTED).into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use axum::http::header::{ORIGIN, WWW_AUTHENTICATE};

    use std::sync::Arc;
    use std::time::Duration;

    use crate::tools::listener::tests::{
        CLAUDE_SESSION, CODEX_SESSION, add_spawn, close, initialize, mcp_session_of, ping,
        serve_stub,
    };
    use crate::tools::server::ToolServerPath;

    const REVISION: &str = "2025-11-25";

    // Each way a request presents itself, one request per row: a live spawn's secret passes, no
    // header, another scheme and a dropped spawn's secret are 401 with no `WWW-Authenticate`, and
    // a live secret from a browser `Origin` is rmcp's 403. Killed by dropping
    // `enforce_origin_validation()` (the `Origin` row passes) and by a 401 that names a challenge.
    #[tokio::test]
    async fn each_way_a_request_presents_its_secret_is_admitted_or_refused() {
        let served = serve_stub().await;
        let (_live, path, secret) = add_spawn(&served.entries, CODEX_SESSION);
        let (dropped, dropped_path, dropped_secret) = add_spawn(&served.entries, CLAUDE_SESSION);
        drop(dropped);

        let admitted = initialize(&served, &path, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(admitted.status(), StatusCode::OK);
        assert!(mcp_session_of(&admitted).is_some());

        let refused = [
            ("no header", initialize(&served, &path, REVISION)),
            (
                "another scheme",
                initialize(&served, &path, REVISION).basic_auth("sidekicks", Some(&secret)),
            ),
            (
                "a dropped spawn's secret",
                initialize(&served, &dropped_path, REVISION).bearer_auth(&dropped_secret),
            ),
        ];
        for (row, request) in refused {
            let response = request.send().await.expect("an answer");
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{row}");
            assert!(!response.headers().contains_key(WWW_AUTHENTICATE), "{row}");
        }

        let from_a_page = initialize(&served, &path, REVISION)
            .bearer_auth(&secret)
            .header(ORIGIN, "https://page.example")
            .send()
            .await
            .expect("an answer");
        assert_eq!(from_a_page.status(), StatusCode::FORBIDDEN);
    }

    // A replaced spawn's secret is refused even on the MCP session it opened, and a live secret is
    // refused with a session another route minted, while the live spawn's own session is served.
    // Killed by checking the secret at `initialize` only, and by admitting any session rmcp holds.
    #[tokio::test]
    async fn a_replaced_spawn_and_another_routes_session_are_refused() {
        let served = serve_stub().await;
        let (_replaced, path, replaced_secret) = add_spawn(&served.entries, CODEX_SESSION);
        let replaced_session = served.open_session(&path, &replaced_secret, REVISION).await;
        let (_live, same_path, live_secret) = add_spawn(&served.entries, CODEX_SESSION);
        assert_eq!(path, same_path);

        let replaced = ping(&served, &path, &replaced_session, REVISION)
            .bearer_auth(&replaced_secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(replaced.status(), StatusCode::UNAUTHORIZED);

        let (_other, other_path, other_secret) = add_spawn(&served.entries, CLAUDE_SESSION);
        let other_session = served
            .open_session(&other_path, &other_secret, REVISION)
            .await;
        let borrowed = ping(&served, &path, &other_session, REVISION)
            .bearer_auth(&live_secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(borrowed.status(), StatusCode::UNAUTHORIZED);

        let live_session = served.open_session(&path, &live_secret, REVISION).await;
        let own = ping(&served, &path, &live_session, REVISION)
            .bearer_auth(&live_secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(own.status(), StatusCode::OK);
    }

    // A session its client closes lets go of its spawn's entry at once, not at the spawn's end.
    // Killed by a parked task that waits on the spawn's end alone, which keeps the entry held.
    #[tokio::test]
    async fn a_session_its_client_closes_lets_go_of_its_spawns_entry() {
        let served = serve_stub().await;
        let (_live, path, secret) = add_spawn(&served.entries, CODEX_SESSION);
        let mcp_session = served.open_session(&path, &secret, REVISION).await;
        let parsed = ToolServerPath::parse(&path).expect("the path parses");
        let authorization = format!("Bearer {secret}");
        let entry = served
            .entries
            .admitted(&parsed, Some(authorization.as_bytes()))
            .expect("the live spawn admits its secret");
        let held = Arc::strong_count(&entry);

        let closed = close(&served, &path, &mcp_session, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert!(closed.status().is_success(), "{}", closed.status());

        tokio::time::timeout(Duration::from_secs(10), async {
            while Arc::strong_count(&entry) >= held {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the closed session's task lets go of the entry");
    }
}
