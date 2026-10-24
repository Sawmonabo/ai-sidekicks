//! Rebuilding a run's leg from its stored binding: which of a session's bindings is its leg, read
//! by session id with no live record, and the resume params composed from that binding's stored
//! legs and the session as it stands now.

use rusqlite::named_params;
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

use crate::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use crate::database::stored_column::text_column;
use crate::provider::driver::mcp_server_status::McpServerStatusProducer;
use crate::provider::driver::session_control::ResumeSessionParams;
use crate::provider::runtime_binding::store::{
    RuntimeBinding, RuntimeBindingStoreError, read_bindings_of_runs,
};
use crate::session::run::ids::SESSION_RUN_IDS_SQL;

/// The function legs a resume injects fresh, apart from the stored legs, so leaving out the
/// status sink is a choice at the call.
#[derive(Clone, Default)]
pub(crate) struct ResumeFunctionLegs {
    /// The status sink bound to the resumed leg.
    pub(crate) on_mcp_server_status: Option<McpServerStatusProducer>,
}

/// A binding with no conversation to resume: recovery starts the leg fresh rather than retry.
#[derive(Debug, thiserror::Error)]
#[error(
    "runtime binding {} of run {run_id} carries no resume handle, so its leg starts fresh",
    .binding_id.as_str()
)]
pub(crate) struct RuntimeBindingNotResumable {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// Its run.
    pub(crate) run_id: RunId,
}

/// Rebuilds a resumed leg's params from its stored binding and the session's lead, model, recorded
/// larger window, mode, permission level's posture, option values and row values, as they stand
/// now. Fails with [`RuntimeBindingNotResumable`] when the binding has no resume handle.
#[expect(
    clippy::too_many_arguments,
    reason = "each argument is one part of the resume the caller holds apart"
)]
pub(crate) fn compose_resume_session_params(
    session_id: SessionId,
    agent_id: AgentId,
    binding: &RuntimeBinding,
    model: ProviderToken,
    larger_window: Option<SafeInt<1>>,
    mode: SessionMode,
    execution_posture: ExecutionPosture,
    options: Vec<ProviderOptionSetting>,
    row_values: ProviderRowValues,
    function_legs: ResumeFunctionLegs,
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
        agent_id,
        resume_handle,
        model,
        larger_window,
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
        on_mcp_server_status: function_legs.on_mcp_server_status,
    })
}

/// The session's leg, its newest binding with a conversation to resume, by when each was recorded
/// and then by id, read through `pool`: the account it runs on and the handle of its conversation,
/// at rest as live; `None` for a session that never ran. Fails as the pool or SQLite fails, or a
/// stored row does not read.
pub(crate) async fn read_session_leg(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<Option<RuntimeBinding>, RuntimeBindingStoreError> {
    pool.read(ReadLength::Short, move |reader| {
        let run_ids = reader
            .prepare_cached(SESSION_RUN_IDS_SQL)?
            .query_map(
                named_params! { "@sessionId": session_id.text().as_str() },
                |row| text_column(row, 0, |text| RunId::new(&text)),
            )?
            .collect::<rusqlite::Result<Vec<RunId>>>()?;
        Ok(read_bindings_of_runs(reader, &run_ids)?
            .into_iter()
            .filter(|binding| binding.resume_handle.is_some())
            .max_by(|left, right| {
                (&left.created_at, &left.id).cmp(&(&right.created_at, &right.id))
            }))
    })
    .await
}
