use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpServerStatus};
use tokio::time::Instant;

use super::{CodexMcpProbeSite, CodexProbedServer, CodexProbedServerStart, probe_site};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
use crate::driver::codex::transport::connection::CodexConnectionHandlers;
use crate::driver::codex::transport::connection::scripted_service::connect_scripted_service;
use crate::driver::mcp_server::status::McpServerReading;

/// The largest message the scripted connection takes, far above any a test sends.
const MESSAGE_LIMIT: usize = 1 << 20;

/// The conversation the scripted service opens.
const THREAD: &str = "probe-thread";

fn user(name: &str) -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: DESCRIPTOR.provider_id(),
        server_name: McpServerName::new(name.to_owned()).expect("a test server name is a name"),
    }
}

fn probed(name: &str, startup_seconds: u64) -> CodexProbedServer {
    CodexProbedServer {
        binding: user(name),
        start: CodexProbedServerStart::LoadedByProvider,
        startup_timeout: Duration::from_secs(startup_seconds),
        is_kept_out: false,
    }
}

// One `mcpServerStatus/list` reply: the server in `runtime_status`.
fn listed(name: &Value, runtime_status: &str) -> Value {
    json!({"data": [{
        "name": name,
        "authStatus": "unsupported",
        "runtimeStatus": runtime_status,
        "tools": {},
        "resources": [],
        "resourceTemplates": [],
    }], "nextCursor": null})
}

// Killed by waiting past the longest startup timeout plus the margin, by a fixed ceiling in place
// of one from the servers' timeouts, by reading an unsettled server as anything but its list's
// status, and by dropping a startup failure's text.
#[tokio::test(start_paused = true)]
async fn a_server_unsettled_at_the_ceiling_reads_its_listed_status() {
    let (events, frames) = CodexDetachedFrames::new();
    let (connection, mut script) = connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
        },
    );
    let site = CodexMcpProbeSite {
        folder: PathBuf::from("/work/app"),
        servers: vec![probed("broken", 7), probed("slow", 12)],
        switched_off_names: vec![McpServerName::new("idle".to_owned()).expect("a name")],
    };
    let began = Instant::now();
    let answering = async {
        let start = script.next_sent().await;
        assert_eq!(start["method"], "thread/start");
        assert_eq!(start["params"]["ephemeral"], json!(true));
        assert_eq!(
            start["params"]["config"]["mcp_servers"],
            json!({"idle": {"enabled": false}})
        );
        script.answer(
            &start,
            &json!({"thread": {"id": THREAD, "sessionId": "session-1"}}),
        );
        script.send(
            &json!({"jsonrpc": "2.0", "method": "mcpServer/startupStatus/updated",
            "params": {"threadId": THREAD, "name": "broken", "status": "failed",
                "error": "handshake refused"}}),
        );
        let mut waited = Vec::new();
        for _ in 0..2 {
            let list = script.next_sent().await;
            assert_eq!(list["method"], "mcpServerStatus/list");
            assert_eq!(list["params"]["threadId"], THREAD);
            waited.push(began.elapsed());
            let status = if list["params"]["serverName"] == "slow" {
                "starting"
            } else {
                "failed"
            };
            script.answer(&list, &listed(&list["params"]["serverName"], status));
        }
        waited
    };

    let (readings, waited) = tokio::join!(probe_site(connection, frames, &site), answering);

    // The longer of the two timeouts, 12 s, and the 5 s margin.
    let ceiling = Duration::from_secs(17);
    assert!(
        waited
            .iter()
            .all(|elapsed| *elapsed >= ceiling && *elapsed < ceiling + Duration::from_secs(1)),
        "{waited:?}"
    );
    let readings = readings.expect("the probe reads");
    let [broken, slow] = readings.as_slice() else {
        panic!("one reading per server");
    };
    assert_eq!(
        broken.reading,
        McpServerReading::Observed(McpServerStatus::Failed)
    );
    assert_eq!(broken.failure_text.as_deref(), Some("handshake refused"));
    assert_eq!(
        slow.reading,
        McpServerReading::Observed(McpServerStatus::Starting)
    );
    assert_eq!(slow.failure_text, None);
}
