use std::collections::HashMap;

use jiff::Timestamp;
use serde_json::json;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{ClaudeMessageFrame, ClaudeMessageRowKind, ClaudeOpenToolCall, read_claude_user_rows};
use crate::driver::claude::delivery::mcp_tasks::ClaudeToolServerTasks;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::run::delivery::LateAppendableRow;

// Killed by a patch completion that names no file in `omittedPatches`, which leaves
// `transcript.patch.list` nothing to list for the call, or names a size other than its patch's.
#[test]
fn a_patch_completion_names_its_file_in_omitted_patches() {
    let run = ClaudeBoundRun {
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        binding_id: RuntimeBindingId::new("binding".to_owned()).expect("a valid binding id"),
    };
    let tool_name = FreeFormText::new("Edit".to_owned()).expect("a tool name");
    let mut open_tool_calls = HashMap::from([(
        "toolu_1".to_owned(),
        ClaudeOpenToolCall::new(tool_name, run, Timestamp::now()),
    )]);
    let frame = json!({
        "type": "user",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "Edited."},
        ]},
        "tool_use_result": {
            "filePath": "/work/notes.md",
            "structuredPatch": [
                {"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1,
                 "lines": ["-old", "+new"]},
            ],
        },
    });
    // The structured result is kept as its raw text, which only a text reader can hold.
    let frame: ClaudeMessageFrame =
        serde_json::from_str(&frame.to_string()).expect("the user frame reads");

    let reading = read_claude_user_rows(
        &frame,
        SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id"),
        &mut open_tool_calls,
        &ClaudeToolServerTasks::default(),
        Timestamp::now(),
        false,
    );

    let [row] = reading.rows.as_slice() else {
        panic!("one row closes the call");
    };
    let ClaudeMessageRowKind::Session {
        row: LateAppendableRow::AgentToolCallCompleted(activity),
        ..
    } = &row.row
    else {
        panic!("the call completes");
    };
    assert_eq!(
        serde_json::to_value(&activity.omitted_patches).expect("the list serializes"),
        json!([{"path": "/work/notes.md", "size": "@@ -1,1 +1,1 @@\n-old\n+new".len()}]),
    );
}
