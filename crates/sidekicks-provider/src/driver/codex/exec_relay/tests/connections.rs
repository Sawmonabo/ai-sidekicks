//! Many connections onto the relay's one executor: each answered apart, and every one closed by
//! the executor's end.

use futures::StreamExt as _;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

use super::{
    ListeningRelay, SOCKET_READ_WAIT, admitted_socket, listening_relay, next_text, send_text,
};
use crate::driver::test_registry::new_session_id;

// Once the executor's output closes, every connection onto it closes too, each socket reading a
// close or its end. Killed by the serve task keeping a sender of its own, which keeps a
// connection open with no executor behind it.
#[tokio::test]
async fn the_executors_end_closes_every_connection() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay,
        fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut sockets = [
        admitted_socket(&url, &presented).await,
        admitted_socket(&url, &presented).await,
    ];
    // Each handshake answered, so each connection is attached before the executor ends.
    for socket in &mut sockets {
        send_text(
            socket,
            &json!({ "id": 1, "method": "initialize", "params": { "clientName": "codex" } }),
        )
        .await;
        assert_eq!(
            next_text(socket).await,
            json!({ "id": 1, "result": { "sessionId": "executor-1" } })
        );
    }

    drop(fake);

    for socket in &mut sockets {
        let read = tokio::time::timeout(SOCKET_READ_WAIT, socket.next())
            .await
            .expect("the connection closes within its wait");
        assert!(
            matches!(read, None | Some(Ok(Message::Close(_)) | Err(_))),
            "the connection reads on: {read:?}"
        );
    }
    // Kept to here, so no connection closes for the relay's own drop.
    drop(relay);
}
