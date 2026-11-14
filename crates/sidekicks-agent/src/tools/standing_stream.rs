//! The standing event stream a tool server answers a client's `GET` with: the stream a client of
//! the older handshake revision keeps open to hear what the server says unasked. It is bound to
//! the spawn's entry and sends `notifications/tools/list_changed` when the entry's tool list on
//! that server changes, and nothing else: no keep-alive and no queue, since a change that arrives
//! while one is unannounced is announced with it. It ends when its client closes it, the spawn
//! drops or the daemon stops.

use std::convert::Infallible;
use std::sync::Arc;

use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::response::Response;
use rmcp::model::{ServerJsonRpcMessage, ServerNotification, ToolListChangedNotification};
use rmcp::transport::common::http_header::EVENT_STREAM_MIME_TYPE;
use tokio_util::sync::CancellationToken;

use crate::tools::entries::{StandingStreamEvent, ToolServerEntry};

/// The standing stream of `entry`'s server `server_name`, which ends at `stop` too.
pub(super) fn standing_stream(
    entry: Arc<ToolServerEntry>,
    server_name: &str,
    stop: CancellationToken,
) -> Response {
    // Taken now, so a change raised once the answer's headers are out is announced.
    let marks = entry.standing_stream_marks(server_name);
    let events = futures::stream::unfold(
        (entry, marks, stop),
        |(entry, mut marks, stop)| async move {
            let event = tokio::select! {
                () = stop.cancelled() => StandingStreamEvent::Closed,
                event = entry.next_standing_event(&mut marks) => event,
            };
            match event {
                StandingStreamEvent::ToolsChanged => Some((
                    Ok::<_, Infallible>(tools_changed_event()),
                    (entry, marks, stop),
                )),
                StandingStreamEvent::Closed => None,
            }
        },
    );
    Response::builder()
        .header(CONTENT_TYPE, EVENT_STREAM_MIME_TYPE)
        .header(CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(events))
        .expect("the stream's headers are valid")
}

// One server-sent event carrying `notifications/tools/list_changed`.
fn tools_changed_event() -> String {
    let notice = ServerJsonRpcMessage::notification(
        ServerNotification::ToolListChangedNotification(ToolListChangedNotification::default()),
    );
    let data = serde_json::to_string(&notice).expect("a notification without params serializes");
    format!("data: {data}\n\n")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use reqwest::StatusCode;
    use reqwest::header::{CONTENT_TYPE, HeaderValue};
    use serde_json::{Value, json};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
    use tokio::time::timeout;

    use crate::tools::listener::tests::{
        CODEX_SESSION, add_spawn, close, serve_stub, standing_get,
    };

    const REVISION: &str = "2025-06-18";

    // Reads `response` until it ends or carries one event; answers that event's data.
    async fn next_event(response: &mut reqwest::Response) -> Option<Value> {
        let mut text = String::new();
        let reading = async {
            while !text.ends_with("\n\n") {
                let chunk = response.chunk().await.expect("the stream reads")?;
                text.push_str(std::str::from_utf8(&chunk).expect("an event is text"));
            }
            Some(())
        };
        timeout(Duration::from_secs(10), reading)
            .await
            .expect("the stream sends or ends in time")?;
        let data = text
            .strip_prefix("data: ")
            .expect("the event carries data")
            .trim_end();
        Some(serde_json::from_str(data).expect("the data is JSON"))
    }

    // A standing stream is refused without the spawn's secret; with it, a raised change reaches it
    // as one `notifications/tools/list_changed`, the client's close ends it, and so does the
    // spawn's drop. Killed by a stream that skips admission, a raise that wakes no stream, an
    // event of another shape, a close that leaves the stream open, and a stream that outlives its
    // spawn.
    #[tokio::test]
    async fn a_raised_change_reaches_an_admitted_stream_which_ends_with_its_close_or_spawn() {
        let served = serve_stub().await;
        let (spawn, path, secret) = add_spawn(&served.entries, CODEX_SESSION);
        let session_id = SessionId::new(CODEX_SESSION).expect("the text is a UUID");

        let unadmitted = standing_get(&served, &path, REVISION)
            .send()
            .await
            .expect("an answer");
        assert_eq!(unadmitted.status(), StatusCode::UNAUTHORIZED);

        let mut stream = standing_get(&served, &path, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(stream.status(), StatusCode::OK);
        assert_eq!(
            stream
                .headers()
                .get(CONTENT_TYPE)
                .map(HeaderValue::as_bytes),
            Some(b"text/event-stream".as_slice())
        );
        served
            .entries
            .raise_tools_changed(session_id, DAEMON_TOOL_SERVER_NAME);
        assert_eq!(
            next_event(&mut stream).await,
            Some(json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}))
        );

        let closed = close(&served, &path, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(closed.status(), StatusCode::OK);
        assert_eq!(
            next_event(&mut stream).await,
            None,
            "the close ends the stream"
        );

        let mut reopened = standing_get(&served, &path, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(reopened.status(), StatusCode::OK);
        drop(spawn);
        assert_eq!(
            next_event(&mut reopened).await,
            None,
            "the spawn's drop ends the stream"
        );
    }
}
