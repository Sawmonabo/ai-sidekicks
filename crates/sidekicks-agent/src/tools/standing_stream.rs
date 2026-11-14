//! The standing event stream a tool server answers a client's `GET` with: the stream a client of
//! the older handshake revision keeps open to hear what the server says unasked. It is bound to
//! the spawn's entry and sends `notifications/tools/list_changed` when the entry's tool list on
//! that server changes, and nothing else: no keep-alive and no queue, since a change that arrives
//! while one is unannounced is announced with it. A change raised while the client had no stream
//! open is announced as its next one opens. It ends when its client closes it, the spawn drops or
//! the daemon stops.

use std::convert::Infallible;

use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::response::Response;
use rmcp::model::{ServerJsonRpcMessage, ServerNotification, ToolListChangedNotification};
use rmcp::transport::common::http_header::EVENT_STREAM_MIME_TYPE;
use tokio_util::sync::CancellationToken;

use crate::tools::entries::{StandingStreamEvent, ToolServerClient};

/// The standing stream `client` opens, which ends at `stop` too.
pub(super) fn standing_stream(client: ToolServerClient, stop: CancellationToken) -> Response {
    // Taken now, so a change raised once the answer's headers are out is announced.
    let marks = client.open_standing_stream();
    let events = futures::stream::unfold(
        (client, marks, stop),
        |(client, mut marks, stop)| async move {
            let event = tokio::select! {
                () = stop.cancelled() => StandingStreamEvent::Closed,
                event = client.next_standing_event(&mut marks) => event,
            };
            match event {
                StandingStreamEvent::ToolsChanged => Some((
                    Ok::<_, Infallible>(tools_changed_event()),
                    (client, marks, stop),
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
    use std::sync::Arc;
    use std::time::Duration;

    use reqwest::StatusCode;
    use reqwest::header::{CONTENT_TYPE, HeaderValue};
    use serde_json::{Value, json};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::port::tool_server_route::ToolServerConversation;
    use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
    use tokio::time::timeout;

    use crate::tools::listener::tests::{
        CODEX_SESSION, Served, add_spawn, close, serve_stub, standing_get,
    };
    use crate::tools::secret_key::ToolServerSecretKey;
    use crate::tools::server::ToolServerPath;

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
    // as one `notifications/tools/list_changed`. A client's close ends its own stream and leaves
    // another client's, here an earlier conversation the spawn adopted; a change raised while the
    // first client has no stream open reaches its next one as it opens; the spawn's drop ends every
    // stream. Killed by a stream that skips admission, a raise that wakes no stream, an event of
    // another shape, a close that ends another client's stream or leaves its own open, a new stream
    // that starts at the current count, and a stream that outlives its spawn.
    #[tokio::test]
    async fn a_raised_change_reaches_each_clients_stream_or_its_next_one_until_it_closes() {
        let served = serve_stub().await;
        let (spawn, path, secret) = add_spawn(&served.entries, CODEX_SESSION);
        let session_id = SessionId::new(CODEX_SESSION).expect("the text is a UUID");

        let unadmitted = standing_get(&served, &path, REVISION)
            .send()
            .await
            .expect("an answer");
        assert_eq!(unadmitted.status(), StatusCode::UNAUTHORIZED);

        let mut stream = open(&served, &path, &secret).await;
        served
            .entries
            .raise_tools_changed(session_id, DAEMON_TOOL_SERVER_NAME);
        assert_eq!(next_event(&mut stream).await, Some(tools_changed()));

        let key = ToolServerSecretKey::of_bytes(1);
        let earlier = ToolServerPath {
            session_id,
            conversation: ToolServerConversation::mint(),
            server_name: DAEMON_TOOL_SERVER_NAME.to_owned(),
        };
        let earlier_secret = key.secret_of(&earlier).text().as_str().to_owned();
        let _adoption = served
            .entries
            .adopt(
                session_id,
                ToolServerConversation::of_session(session_id),
                Arc::new(key),
            )
            .expect("the spawn runs the session's own conversation");
        let mut adopted = open(&served, &earlier.to_string(), &earlier_secret).await;
        assert_eq!(
            next_event(&mut adopted).await,
            Some(tools_changed()),
            "a client's first stream announces a change raised before it"
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
            "the close ends the client's stream"
        );
        served
            .entries
            .raise_tools_changed(session_id, DAEMON_TOOL_SERVER_NAME);
        assert_eq!(
            next_event(&mut adopted).await,
            Some(tools_changed()),
            "another client's stream outlives the close"
        );

        let mut reopened = open(&served, &path, &secret).await;
        assert_eq!(
            next_event(&mut reopened).await,
            Some(tools_changed()),
            "a change raised with no stream open is announced as the next one opens"
        );
        drop(spawn);
        assert_eq!(
            next_event(&mut reopened).await,
            None,
            "the spawn's drop ends the stream"
        );
        assert_eq!(next_event(&mut adopted).await, None);
    }

    // The standing stream on `path` presenting `secret`, checked open as an event stream.
    async fn open(served: &Served, path: &str, secret: &str) -> reqwest::Response {
        let stream = standing_get(served, path, REVISION)
            .bearer_auth(secret)
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
        stream
    }

    // The event a changed tool list is announced with.
    fn tools_changed() -> Value {
        json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
    }
}
