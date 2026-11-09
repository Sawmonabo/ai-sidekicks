//! The `agent.command.*` methods served here: the running-commands subscription, over the
//! session's running set once the session is found, and the person's stop, background and write,
//! each over the set through the driver the session runs on; a helper's move to the background
//! goes to that driver once the session's agent tree names the helper live.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::command::{
    AgentCommandBackground, AgentCommandBackgroundResponse, AgentCommandBackgroundTarget,
    AgentCommandStop, AgentCommandStopResponse, AgentCommandSubscribe, AgentCommandSubscribeFrame,
    AgentCommandSubscribeRequest, AgentCommandWrite,
};
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::NullPayload;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::{False, True};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_provider::command::helper_background::{
    HelperBackgroundParams, helper_not_in_foreground, move_helper_to_background,
};
use sidekicks_provider::command::running_set::{CommandInput, RunningCommandSets};
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::agent_tree::controls::ChildRunControlError;
use sidekicks_session::agent_tree::read::{AgentTreeReadError, ResolvedChild, resolve_child};
use sidekicks_session::directory::lookups::session_exists;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

/// What the command methods read and act through.
pub(crate) struct CommandMethodSources {
    /// The read pool the session's existence and a helper's node are read on.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The sessions' running commands.
    pub(crate) running: Arc<RunningCommandSets>,
    /// The drivers a session's acts go through.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// Where each session's log is damaged from, so its binding is read from the part before.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

impl CommandMethodSources {
    // The driver `session_id` runs on; refused `session.notFound` for a session this daemon holds
    // no binding for, and `provider.notFound` for a provider no driver answers.
    async fn session_driver(
        &self,
        session_id: SessionId,
    ) -> Result<Arc<dyn ProviderDriver>, HandlerError> {
        let (_, _, driver) = read_session_driver::<SessionReadError>(
            &self.pool,
            &self.providers,
            self.read_damaged_from_sequence.as_ref(),
            session_id,
        )
        .await?;
        Ok(driver)
    }

    // The provider's own id for the helper `child_handle` of `run_id` in `session_id`; refused
    // `agent.childRun.notFound` for a handle that names no helper of that run, and
    // `agent.command.notInForeground` for one that has finished.
    async fn live_helper(
        &self,
        session_id: SessionId,
        run_id: RunId,
        child_handle: &ChildHandle,
    ) -> Result<SubagentId, HandlerError> {
        let read_handle = child_handle.clone();
        let child = self
            .pool
            .read(
                ReadLength::Short,
                move |reader| -> Result<Option<ResolvedChild>, SessionReadError> {
                    Ok(resolve_child(reader, &session_id, &read_handle)?)
                },
            )
            .await?
            .filter(|child| child.parent_run_id == run_id)
            .ok_or_else(|| ChildRunControlError::ChildNotFound {
                child_handle: child_handle.clone(),
            })?;
        if child.state.is_terminal() {
            return Err(helper_not_in_foreground(run_id, child_handle).into());
        }
        Ok(child.node.subagent_id)
    }
}

/// Why a command method's read of its session failed.
#[derive(Debug, thiserror::Error)]
enum SessionReadError {
    /// SQLite refused the session's read.
    #[error("the session of a command method could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The session or its provider was refused.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A helper's node or its own run could not be read.
    #[error(transparent)]
    Tree(#[from] AgentTreeReadError),
}

impl From<SessionReadError> for HandlerError {
    fn from(error: SessionReadError) -> Self {
        match error {
            SessionReadError::Refused(refusal) => Self::Refused(refusal),
            failure @ (SessionReadError::Read(_)
            | SessionReadError::Pool(_)
            | SessionReadError::Tree(_)) => Self::Internal(Box::new(failure)),
        }
    }
}

/// Registers `agent.command.subscribe`, `.stop`, `.background` and `.write` over `sources`; a
/// session this daemon holds no row for, or for an act no binding, is refused with
/// `session.notFound`, and a helper the session's agent tree does not name under the run given
/// with `agent.childRun.notFound`. Fails the start when one is already registered.
pub(crate) fn register_command_methods(
    registry: &mut MethodRegistryBuilder,
    sources: &Arc<CommandMethodSources>,
) -> Result<(), RegistrationError> {
    let subscribe_sources = Arc::clone(sources);
    registry.register_subscription::<AgentCommandSubscribe, _>(
        move |request: AgentCommandSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let sources = Arc::clone(&subscribe_sources);
            async move {
                require_session(&sources.pool, request.session_id).await?;
                let feed: Box<dyn Feed<Emission = AgentCommandSubscribeFrame>> =
                    Box::new(sources.running.subscribe(request.session_id));
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let stop_sources = Arc::clone(sources);
    registry.register::<AgentCommandStop, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&stop_sources);
        async move {
            let driver = sources.session_driver(request.session_id).await?;
            sources
                .running
                .stop(driver.as_ref(), request.session_id, &request.command_id)
                .await?;
            Ok(AgentCommandStopResponse {
                command_id: request.command_id,
                stopped: True::default(),
            })
        }
        .boxed()
    })?;
    let background_sources = Arc::clone(sources);
    registry.register::<AgentCommandBackground, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&background_sources);
        async move {
            let driver = sources.session_driver(request.session_id).await?;
            match &request.target {
                AgentCommandBackgroundTarget::Command { command_id } => {
                    sources
                        .running
                        .move_to_background(driver.as_ref(), request.session_id, command_id)
                        .await?;
                }
                AgentCommandBackgroundTarget::Helper {
                    run_id,
                    child_handle,
                } => {
                    let subagent_id = sources
                        .live_helper(request.session_id, *run_id, child_handle)
                        .await?;
                    let params = HelperBackgroundParams {
                        session_id: request.session_id,
                        run_id: *run_id,
                        child_handle: child_handle.clone(),
                        subagent_id,
                    };
                    move_helper_to_background(driver.as_ref(), params).await?;
                }
            }
            Ok(AgentCommandBackgroundResponse {
                target: request.target,
                waiting_in_foreground: False::default(),
            })
        }
        .boxed()
    })?;
    let write_sources = Arc::clone(sources);
    registry.register::<AgentCommandWrite, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&write_sources);
        async move {
            let driver = sources.session_driver(request.session_id).await?;
            let input = CommandInput {
                text: request.text.map(|text| text.as_str().to_owned()),
                is_end_of_input: request.end_of_input == Some(true),
            };
            sources
                .running
                .write(
                    driver.as_ref(),
                    request.session_id,
                    &request.command_id,
                    input,
                )
                .await?;
            Ok(NullPayload)
        }
        .boxed()
    })
}

// Refuses a session this daemon holds no row for.
async fn require_session(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<(), HandlerError> {
    let exists = pool
        .read(
            ReadLength::Short,
            move |reader| -> Result<bool, SessionReadError> {
                Ok(session_exists(reader, &session_id)?)
            },
        )
        .await?;
    if exists {
        Ok(())
    } else {
        Err(session_not_found(&session_id).into())
    }
}
