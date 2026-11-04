use rstest::rstest;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::run::subagent::SubagentId;

use super::attribute_codex_ask;
use crate::driver::codex::delivery::memory::{CodexBoundChildRun, CodexChildRun};
use crate::driver::codex::delivery::rows::test_row_run;
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::server_requests::{
    CodexAskKind, CodexAskOwner, CodexInboundServerRequest, CodexRoutedAskAttribution,
    CodexRoutedMethod,
};
use crate::driver::codex::session::establishment::helpers::bind_codex_helper_run;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
use crate::driver::test_registry::new_run_id;

/// A helper's own conversation, which is its id.
const HELPER_THREAD: &str = "helper-thread";

/// The lead's live turn.
const LEAD_TURN: &str = "lead-turn";

/// The run an ask is expected to land on.
#[derive(Debug)]
enum Expected {
    Helper,
    Lead,
    Refused,
}

// A helper's approval waits under the helper's own run, even when it names the lead's live turn,
// and one from a helper whose run did not start is refused; the lead's own ask stays the lead's.
// Killed by dropping the helper check, so a helper's ask goes to the lead's turn (the first three
// cases), and by putting the helper check after the turn check (the second).
#[rstest]
#[case::helper_on_its_own_thread(HELPER_THREAD, None, true, Expected::Helper)]
#[case::helper_naming_the_leads_turn(HELPER_THREAD, Some(LEAD_TURN), true, Expected::Helper)]
#[case::helper_with_no_run(HELPER_THREAD, Some(LEAD_TURN), false, Expected::Refused)]
#[case::lead_on_its_own_thread(TEST_THREAD, Some(LEAD_TURN), true, Expected::Lead)]
#[tokio::test]
async fn a_helpers_ask_is_attributed_to_its_own_run(
    #[case] thread_id: &str,
    #[case] turn_id: Option<&str>,
    #[case] is_helper_bound: bool,
    #[case] expected: Expected,
) {
    let mut session = TestCodexSession::start().await;
    let run_routes = &session.task.run_routes;
    let record = &mut session.task.record;
    let mut lead = test_row_run();
    lead.session_id = record.session_id;
    run_routes.bind_run_delivery(
        lead.run_id,
        CodexRunBinding {
            session_id: lead.session_id,
            binding_id: lead.binding_id.clone(),
            agent_id: lead.agent_id,
            step_bound: None,
        },
    );
    record.add_active_turn(LEAD_TURN.to_owned(), lead.run_id);
    let helper_run_id = new_run_id();
    let helper_binding_id = test_row_run().binding_id;
    bind_codex_helper_run(
        record,
        run_routes,
        HELPER_THREAD.to_owned(),
        CodexChildRun {
            bound: is_helper_bound.then_some(CodexBoundChildRun {
                child_run_id: helper_run_id,
                parent_run_id: lead.run_id,
                start_row_event_id: None,
            }),
            agent_id: lead.agent_id,
            binding_id: helper_binding_id.clone(),
            subagent_id: SubagentId::new(HELPER_THREAD.to_owned()).expect("a helper id"),
            parent_tool_call_id: None,
        },
    );
    let params = match turn_id {
        Some(turn_id) => json!({"threadId": thread_id, "turnId": turn_id, "itemId": "item-1"}),
        None => json!({"threadId": thread_id, "itemId": "item-1"}),
    };
    let request = CodexInboundServerRequest {
        request_id: "1".to_owned(),
        method: CodexRoutedMethod::CommandExecutionApproval,
        ask_kind: CodexAskKind::Approval,
        params: RawValue::from_string(params.to_string()).expect("the params are JSON"),
    };

    let attribution = attribute_codex_ask(record, run_routes, &request);

    match expected {
        Expected::Helper => assert_eq!(
            attribution,
            CodexRoutedAskAttribution::Attributed {
                owner: CodexAskOwner {
                    run_id: helper_run_id,
                    binding_id: helper_binding_id,
                },
            }
        ),
        Expected::Lead => assert_eq!(
            attribution,
            CodexRoutedAskAttribution::Attributed {
                owner: CodexAskOwner {
                    run_id: lead.run_id,
                    binding_id: lead.binding_id,
                },
            }
        ),
        Expected::Refused => assert!(
            matches!(attribution, CodexRoutedAskAttribution::Refused { .. }),
            "{attribution:?}"
        ),
    }
}
