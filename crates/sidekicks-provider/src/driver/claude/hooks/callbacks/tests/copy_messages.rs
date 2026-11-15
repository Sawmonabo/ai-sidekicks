//! A one-turn copy's helper-limit hook on a message call: checked by the session's own stops and
//! pauses, in their words, before it counts as a wake.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use super::{ENDED, StoredTarget, TARGET, answer_value};
use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::driver::claude::hooks::helper_limit::copy::{
    ClaudeCopyHelpers, ClaudeSessionHelperCount,
};
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::inbound::{
    ClaudeHookCallback, ClaudeInboundRequest, ClaudeInboundRequestBody,
};
use crate::driver::run_control::HelperStopReason;
use crate::driver::test_registry::fixed_session_id;
use crate::port::agent_tree_lookup::AgentTreeLookup;

// The helper-limit hook's request `request_id` from the copy's lead for the call `input` names.
fn helper_limit_request(request_id: &str, input: &Value) -> ClaudeInboundRequest {
    ClaudeInboundRequest {
        request_id: request_id.to_owned(),
        body: ClaudeInboundRequestBody::HookCallback(ClaudeHookCallback {
            callback_id: Some(RegisteredHook::HelperLimit.id().to_owned()),
            tool_use_id: None,
            input: Some(RawValue::from_string(input.to_string()).expect("a JSON input")),
        }),
    }
}

// A copy's message to an ended helper the person stopped with every other agent is denied with the
// stop's sentence, as the session's own process denies it, and takes no slot, so the copy's next
// helper start is let through under a limit of one. Killed by a copy that counts the message as a
// wake (the message passed, the start held unanswered).
#[tokio::test]
async fn a_message_from_a_copy_to_a_helper_stopped_with_all_is_denied_uncounted() {
    let session_id = fixed_session_id();
    let agent_tree_lookup = Arc::new(PortRegistration::new("agent tree"));
    agent_tree_lookup
        .register(Arc::new(StoredTarget(ENDED)) as Arc<dyn AgentTreeLookup>)
        .expect("the agent tree registers once");
    let pauses = Arc::new(Mutex::new(ClaudeRunPauses::default()));
    lock(&pauses).stop_helper(session_id, TARGET, HelperStopReason::StopAll);
    let channel = Arc::new(ScriptedChannel::default());
    let account_id = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    let copy = ClaudeCopyHelpers::count(
        ClaudeSessionHelperCount {
            limit: Arc::new(Mutex::new(ClaudeHelperLimit::default())),
            agent_tree_lookup,
            pauses,
            tasks: TaskTracker::new(),
        },
        session_id,
        NonZeroUsize::MIN,
        Arc::clone(&channel) as Arc<dyn ClaudeProcessChannel>,
        ClaudeProcessAccount::new(Some(account_id)),
        "copy".to_owned(),
    );

    let message = json!({
        "tool_name": "SendMessage",
        "tool_use_id": "send-1",
        "tool_input": { "to": TARGET, "message": "go on" },
    });
    let start = json!({ "tool_name": "Agent", "tool_use_id": "start-1" });
    for (request_id, input) in [("send-1", &message), ("start-1", &start)] {
        let handed_back = copy
            .take_request(helper_limit_request(request_id, input))
            .await;
        assert!(
            handed_back.is_none(),
            "the copy answers its helper-limit hook itself"
        );
    }

    let denied = answer_value(&ClaudeHookAnswer::Deny {
        reason: HelperStopReason::StopAll.sentence(),
    });
    assert_eq!(
        channel.answers(),
        [
            ("send-1".to_owned(), denied),
            ("start-1".to_owned(), answer_value(&ClaudeHookAnswer::Pass)),
        ]
    );
}
