//! The `agent.command.*` methods served here: the running-commands subscription, over the
//! session's running set once the session is found, and the person's stop, background and write,
//! each over the set through the driver the session runs on.

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
use crate::events::session::read::DamagedFromSequenceReader;
use crate::ipc::domain_error::DomainError;
use crate::ipc::handlers::driver::resolution::read_session_driver;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::ipc::stream::feed::Feed;
use crate::provider::command::running_set::{CommandInput, RunningCommandSets};
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::directory::lookups::session_exists;
use crate::session::not_found::session_not_found;

/// What the command methods read and act through.
pub(crate) struct CommandMethodSources {
    /// The read pool the session's existence is read on.
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
}

impl From<SessionReadError> for HandlerError {
    fn from(error: SessionReadError) -> Self {
        match error {
            SessionReadError::Refused(refusal) => Self::Refused(refusal),
            failure @ (SessionReadError::Read(_) | SessionReadError::Pool(_)) => {
                Self::Internal(Box::new(failure))
            }
        }
    }
}

/// Registers `agent.command.subscribe`, `.stop`, `.background` and `.write` over `sources`; a
/// session this daemon holds no row for, or for an act no binding, is refused with
/// `session.notFound`. Fails the start when one is already registered.
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
            sources
                .running
                .move_to_background(driver.as_ref(), request.session_id, &request.command_id)
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
