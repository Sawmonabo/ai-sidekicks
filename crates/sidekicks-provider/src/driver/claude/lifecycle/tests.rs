use std::time::Duration;

use serde_json::Map;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::claude::session::scripted::binding_id;
use crate::driver::contract::{RunOpening, RunOpeningItem, StartRunParams};
use crate::driver::session_control::ResumeSessionParams;
use crate::runtime_binding::store::mint_runtime_binding_id;
use crate::runtime_binding::test_store::test_provider_account_id;

mod bring_up;
mod naming;
mod restarts;
mod resumed_runs;
mod session_controls;
mod settings_reads;

/// Longer than every restart's wait, so a restart that would come has come.
const RESTART_WAITS_PASSED: Duration = Duration::from_secs(5);

fn start_params(session_id: SessionId, run_id: RunId) -> StartRunParams {
    StartRunParams {
        run_id,
        opening: RunOpening {
            session_id,
            binding_id: binding_id("lead"),
            agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an id"),
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

fn resume_params(session_id: SessionId) -> ResumeSessionParams {
    ResumeSessionParams {
        session_id,
        binding_id: mint_runtime_binding_id(),
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        resume_handle: "conversation".to_owned(),
        model: ProviderToken::new("opus".to_owned()).expect("the model fits"),
        larger_window: None,
        runtime_metadata: Map::new(),
        mode: SessionMode::Build,
        execution_posture: None,
        output_speed: None,
        options: Vec::new(),
        row_values: Record::default(),
        callback_tools: None,
        subagent_policy: None,
        tool_servers: None,
        output_schema: None,
        provider_account_id: test_provider_account_id(),
        on_mcp_server_status: None,
        kept_schedules: Vec::new(),
        live_runs: Vec::new(),
    }
}
