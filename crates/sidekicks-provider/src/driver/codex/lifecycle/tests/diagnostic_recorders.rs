//! What a live session hands the daemon's diagnostic recorders: each message Codex sends, and
//! each finished tool call's trace.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{LiveCodexSession, TEST_TURN, wait_until};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::session::test_fixture::TEST_THREAD;
use crate::port::raw_provider_messages::RawProviderMessages;
use crate::port::raw_provider_messages::test_port::KeptRawMessages;
use crate::port::tool_traces::ToolTraces;
use crate::port::tool_traces::test_port::KeptToolTraces;

// A message Codex sends reaches the raw-message port word for word, and a finished command's item
// is traced with its command as its arguments and the whole item as its result. Killed by
// deleting the connection reader's tap (no message) and by deleting the trace at an item's end
// (no trace).
#[tokio::test]
async fn codexs_messages_and_a_finished_calls_trace_are_recorded() {
    let session = LiveCodexSession::start(&[]).await;
    let raw_messages = Arc::new(KeptRawMessages::default());
    raw_messages.set_recording(true);
    assert!(
        session
            .scripted
            .dependencies
            .raw_messages
            .register(Arc::clone(&raw_messages) as Arc<dyn RawProviderMessages>)
            .is_ok()
    );
    let tool_traces = Arc::new(KeptToolTraces::default());
    tool_traces.set_recording(true);
    assert!(
        session
            .driver
            .ports
            .tool_traces
            .register(Arc::clone(&tool_traces) as Arc<dyn ToolTraces>)
            .is_ok()
    );
    let item = json!({
        "type": "commandExecution",
        "id": "call-1",
        "command": "ls",
        "status": "completed",
        "aggregatedOutput": "README.md\n",
        "exitCode": 0,
    });
    let frame = json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": { "threadId": TEST_THREAD, "turnId": TEST_TURN, "item": item },
    });

    session.scripted.script.send(&frame);
    wait_until(|| !tool_traces.traces().is_empty()).await;

    assert!(
        raw_messages
            .messages()
            .contains(&(DESCRIPTOR.provider_id(), frame.to_string())),
        "the frame is kept as Codex sent it: {:?}",
        raw_messages.messages()
    );
    let traces = tool_traces.traces();
    assert_eq!(traces.len(), 1, "the finished call is traced once");
    assert_eq!(traces[0].session_id, session.session_id);
    assert_eq!(traces[0].tool_call_id, "call-1");
    assert_eq!(traces[0].tool_name, "commandExecution");
    assert_eq!(traces[0].arguments.get(), r#""ls""#);
    let result: Value =
        serde_json::from_str(traces[0].result.get()).expect("the result is the item's JSON");
    assert_eq!(result, item);
}
