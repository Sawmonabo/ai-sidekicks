//! Rebuilding a run's leg from its stored binding: the resume params composed from that binding's
//! stored legs and the session as it stands now.

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::declaration::ProviderOptionSetting;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::driver::idle_sleep::KeptSchedule;
use crate::driver::mcp_server::status::McpServerStatusProducer;
use crate::driver::session_control::{LiveRunResume, ResumeSessionParams};
use crate::runtime_binding::store::RuntimeBinding;

/// The function legs a relaunch opens fresh for a resumed leg, apart from the stored legs.
#[derive(Clone, Default)]
pub struct ResumeFunctionLegs {
    /// The status sink bound to the resumed leg.
    pub on_mcp_server_status: Option<McpServerStatusProducer>,
}

/// A binding with no conversation to resume: recovery starts the leg fresh rather than retry.
#[derive(Debug, thiserror::Error)]
#[error(
    "runtime binding {} of run {run_id} carries no resume handle, so its leg starts fresh",
    .binding_id.as_str()
)]
pub struct RuntimeBindingNotResumable {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// Its run.
    pub(crate) run_id: RunId,
}

/// Rebuilds a resumed leg's params from its stored binding, with the provider's recovery data on
/// it, and the session's lead, model, recorded larger window, mode, permission level's posture,
/// option values, row values, kept schedules and live runs, as they stand now, the resumed process
/// to run under `binding_id`, with no function legs, which a relaunch that opens them sets after.
/// Fails with [`RuntimeBindingNotResumable`] when the binding has no resume handle.
#[expect(
    clippy::too_many_arguments,
    reason = "each argument is one part of the resume the caller holds apart"
)]
pub fn compose_resume_session_params(
    session_id: SessionId,
    agent_id: AgentId,
    binding: &RuntimeBinding,
    binding_id: RuntimeBindingId,
    model: ProviderToken,
    larger_window: Option<SafeInt<1>>,
    mode: SessionMode,
    execution_posture: ExecutionPosture,
    options: Vec<ProviderOptionSetting>,
    row_values: ProviderRowValues,
    kept_schedules: Vec<KeptSchedule>,
    live_runs: Vec<LiveRunResume>,
) -> Result<ResumeSessionParams, RuntimeBindingNotResumable> {
    let Some(resume_handle) = binding.resume_handle.clone() else {
        return Err(RuntimeBindingNotResumable {
            binding_id: binding.id.clone(),
            run_id: binding.run_id,
        });
    };
    let spawn_config = binding.spawn_config.clone();
    Ok(ResumeSessionParams {
        session_id,
        binding_id,
        agent_id,
        resume_handle,
        model,
        larger_window,
        runtime_metadata: binding.runtime_metadata.clone(),
        mode,
        // The level the session was last moved to, which may differ from the one it launched at.
        execution_posture: Some(execution_posture),
        output_speed: spawn_config.output_speed,
        options,
        row_values,
        callback_tools: spawn_config.callback_tools,
        subagent_policy: spawn_config.subagent_policy,
        tool_servers: spawn_config.tool_servers,
        output_schema: spawn_config.output_schema,
        // Read back as stored, never resolved again.
        provider_account_id: spawn_config.provider_account_id,
        on_mcp_server_status: None,
        kept_schedules,
        live_runs,
    })
}
