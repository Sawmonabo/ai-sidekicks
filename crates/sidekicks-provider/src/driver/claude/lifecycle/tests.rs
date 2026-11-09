use std::time::Duration;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::claude::session::scripted::binding_id;
use crate::driver::contract::params_and_results::{RunOpening, RunOpeningItem, StartRunParams};
use crate::driver::test_registry::new_agent_id;

mod account_switch;
mod bring_up;
mod daemon_stop;
mod hand_over;
mod held_calls;
mod inspector_reads;
mod level_moves;
mod naming;
mod restarts;
mod resting_commands;
mod resumed_runs;
mod session_controls;
mod settings_reads;
mod side_question;
mod staged_reviews;

/// Longer than every restart's wait, so a restart that would come has come.
const RESTART_WAITS_PASSED: Duration = Duration::from_secs(5);

fn start_params(session_id: SessionId, run_id: RunId) -> StartRunParams {
    StartRunParams {
        run_id,
        opening: RunOpening {
            session_id,
            binding_id: binding_id("lead"),
            agent_id: new_agent_id(),
            message_id: QueueItemId::new(&mint_uuid_v7().to_string())
                .expect("a minted UUID is an item id"),
            item: RunOpeningItem::Message {
                content: FreeFormText::new("go".to_owned()).expect("the words fit"),
                attachments: Vec::new(),
                skills: Vec::new(),
            },
        },
        conversation_history: None,
        output_speed: None,
        options: Vec::new(),
        output_speed_for_turn: None,
        execution_posture: None,
        output_schema: None,
        step_bound: None,
    }
}
