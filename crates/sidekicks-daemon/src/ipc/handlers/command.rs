//! The `agent.command.*` methods served here: the running-commands subscription and the person's
//! stop, background and write, each over the session's running set after the session is found.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::command::{
    AgentCommandBackground, AgentCommandBackgroundResponse, AgentCommandStop,
    AgentCommandStopResponse, AgentCommandSubscribe, AgentCommandSubscribeFrame,
    AgentCommandSubscribeRequest, AgentCommandWrite,
};
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::NullPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::{False, True};

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::ipc::stream::feed::Feed;
use crate::provider::command::running_set::{CommandInput, RunningCommandSets};
use crate::session::directory::lookups::session_exists;
use crate::session::not_found::session_not_found;

/// What the command methods read and act through.
pub(crate) struct CommandMethodSources {
    /// The read pool the session's existence is read on.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The sessions' running commands.
    pub(crate) running: Arc<RunningCommandSets>,
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
}

impl From<SessionReadError> for HandlerError {
    fn from(error: SessionReadError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Registers `agent.command.subscribe`, `.stop`, `.background` and `.write` over `sources`; a
/// session this daemon holds no row for is refused with `session.notFound`. Fails the start when
/// one is already registered.
#[expect(
    dead_code,
    reason = "the daemon's start registers the command methods over the running set"
)]
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
            require_session(&sources.pool, request.session_id).await?;
            sources
                .running
                .stop(request.session_id, &request.command_id)
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
            require_session(&sources.pool, request.session_id).await?;
            sources
                .running
                .move_to_background(request.session_id, &request.command_id)
                .await?;
            Ok(AgentCommandBackgroundResponse {
                command_id: request.command_id,
                waiting_in_foreground: False::default(),
            })
        }
        .boxed()
    })?;
    let write_sources = Arc::clone(sources);
    registry.register::<AgentCommandWrite, _>(move |request, _context: HandlerContext| {
        let sources = Arc::clone(&write_sources);
        async move {
            require_session(&sources.pool, request.session_id).await?;
            let input = CommandInput {
                text: request.text.map(|text| text.as_str().to_owned()),
                is_end_of_input: request.end_of_input == Some(true),
            };
            sources
                .running
                .write(request.session_id, &request.command_id, input)
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
