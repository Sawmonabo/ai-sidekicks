//! The session controls a client calls on the session's provider: `session.permissionLevel.update`
//! and `session.mode.update` move the level and the Build or Plan mode, `session.sideQuestion.ask`
//! asks on a throwaway copy of the conversation, `session.codeReview.start` starts the provider's
//! own review, and `session.providerCommand.subscribe` follows the live `/` list. Each refuses a
//! session the daemon does not hold, then one whose provider no driver answers, before anything
//! changes or opens.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandEntry, ProviderCommandListResponse,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::{
    SessionAcknowledgment, SessionAddressedRequest, SessionCodeReviewStart,
    SessionCodeReviewStartRequest, SessionModeUpdate, SessionModeUpdateRequest,
    SessionModeUpdateResponse, SessionPermissionLevelUpdate, SessionPermissionLevelUpdateRequest,
    SessionPermissionLevelUpdateResponse, SessionProviderCommandList,
    SessionProviderCommandSubscribe, SessionServerPrompt, SessionSideQuestionAsk,
    SessionSideQuestionAskRequest, SessionSideQuestionAskResponse, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_provider::driver::capabilities::DriverCapabilityFlag;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::session_control::{
    AskSideQuestionParams, SubscribeProviderCommandsParams,
};
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_queue::service::RunQueue;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;

use crate::ipc::handlers::driver::DriverMethodSources;

/// What the session controls read and act through.
pub(crate) struct SessionControlMethods {
    /// The reads that resolve a session's driver, and the drivers.
    pub(crate) sources: Arc<DriverMethodSources>,
    /// Moves a session's level and mode, starts a review on a running process and composes a side
    /// question's resume material, each by where the session's process stands.
    pub(crate) provider_sessions: Arc<ProviderSessions>,
    /// Queues a review as a session's next item when no process runs it.
    pub(crate) run_queue: Arc<RunQueue>,
}

/// Why a session's driver was not resolved: a refusal the caller reads by its code, or a read that
/// did not run.
#[derive(Debug, thiserror::Error)]
enum SessionControlFailure {
    /// The session is not one the daemon holds, or no driver answers its provider.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused the read, or a stored value does not read as its type.
    #[error("a session control's read of the session's lead failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error("the read pool did not run a session control's read of the session's lead")]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionControlFailure> for HandlerError {
    fn from(failure: SessionControlFailure) -> Self {
        match failure {
            SessionControlFailure::Refused(refusal) => Self::Refused(refusal),
            fault @ (SessionControlFailure::Read(_) | SessionControlFailure::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Registers the five session controls over `methods`, each refusing by the codes its method lists,
/// a refused move keeping nothing and a refused follow leaving nothing open. Fails the start when
/// one is already registered.
pub(crate) fn register_session_controls(
    registry: &mut MethodRegistryBuilder,
    methods: SessionControlMethods,
) -> Result<(), RegistrationError> {
    let methods = Arc::new(methods);
    let leveling = Arc::clone(&methods);
    registry.register::<SessionPermissionLevelUpdate, _>(
        move |request: SessionPermissionLevelUpdateRequest, _context: HandlerContext| {
            let methods = Arc::clone(&leveling);
            async move {
                let SessionPermissionLevelUpdateRequest { session_id, level } = request;
                resolve_driver(&methods.sources, session_id).await?;
                methods
                    .provider_sessions
                    .change_level(session_id, level)
                    .await?;
                Ok(SessionPermissionLevelUpdateResponse { session_id, level })
            }
            .boxed()
        },
    )?;
    let moding = Arc::clone(&methods);
    registry.register::<SessionModeUpdate, _>(
        move |request: SessionModeUpdateRequest, _context: HandlerContext| {
            let methods = Arc::clone(&moding);
            async move {
                let SessionModeUpdateRequest { session_id, mode } = request;
                resolve_driver(&methods.sources, session_id).await?;
                methods
                    .provider_sessions
                    .change_mode(session_id, mode)
                    .await?;
                Ok(SessionModeUpdateResponse { session_id, mode })
            }
            .boxed()
        },
    )?;
    let asking = Arc::clone(&methods);
    registry.register::<SessionSideQuestionAsk, _>(
        move |request: SessionSideQuestionAskRequest, _context: HandlerContext| {
            let methods = Arc::clone(&asking);
            async move { ask_side_question(&methods, request).await }.boxed()
        },
    )?;
    let reviewing = Arc::clone(&methods);
    registry.register::<SessionCodeReviewStart, _>(
        move |request: SessionCodeReviewStartRequest, _context: HandlerContext| {
            let methods = Arc::clone(&reviewing);
            async move {
                let session_id = request.session_id;
                resolve_driver(&methods.sources, session_id).await?;
                let run_queue = &methods.run_queue;
                methods
                    .provider_sessions
                    .start_review(request, |queued| run_queue.queue_review(queued))
                    .await?;
                Ok(SessionAcknowledgment { session_id })
            }
            .boxed()
        },
    )?;
    registry.register_subscription::<SessionProviderCommandSubscribe, _>(
        move |request: SessionAddressedRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let methods = Arc::clone(&methods);
            async move {
                let feed = follow_provider_commands(&methods.sources, request.session_id).await?;
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

// The provider the session's lead runs on and its driver, after the session and its provider
// pass.
async fn resolve_driver(
    sources: &DriverMethodSources,
    session_id: SessionId,
) -> Result<(ProviderId, Arc<dyn ProviderDriver>), SessionControlFailure> {
    let (provider, _, driver) = read_session_driver::<SessionControlFailure>(
        &sources.pool,
        &sources.providers,
        sources.read_damaged_from_sequence.as_ref(),
        session_id,
    )
    .await?;
    Ok((provider, driver))
}

// Asks on a copy forked from the session's newest conversation, which the driver takes from its
// live process where one runs; the answer arrives later as an event under the minted id.
async fn ask_side_question(
    methods: &SessionControlMethods,
    request: SessionSideQuestionAskRequest,
) -> Result<SessionSideQuestionAskResponse, HandlerError> {
    let SessionSideQuestionAskRequest {
        session_id,
        question,
    } = request;
    let (_, driver) = resolve_driver(&methods.sources, session_id).await?;
    let resume = methods
        .provider_sessions
        .side_question_resume(session_id)
        .await?;
    let side_question_id =
        SideQuestionId::try_from(mint_uuid_v7()).expect("a minted UUID is a side question id");
    driver
        .ask_side_question(AskSideQuestionParams {
            session_id,
            side_question_id,
            question: question.0.into_string(),
            resume,
        })
        .await?;
    Ok(SessionSideQuestionAskResponse {
        session_id,
        side_question_id,
    })
}

// Follows the session's live `/` list, gated on the provider's command list before the driver
// follows anything, so a refusal leaves nothing open.
async fn follow_provider_commands(
    sources: &DriverMethodSources,
    session_id: SessionId,
) -> Result<Box<dyn Feed<Emission = SessionProviderCommandList>>, HandlerError> {
    let (provider, driver) = resolve_driver(sources, session_id).await?;
    sources
        .providers
        .check_capability(&provider, DriverCapabilityFlag::ProviderCommands)?;
    let feed = LatestValueFeed::open(|outlet| async move {
        let subscription = driver.subscribe_provider_commands(
            SubscribeProviderCommandsParams { session_id },
            Arc::new(move |list: ProviderCommandListResponse| {
                outlet.send(session_command_list(session_id, list));
            }),
        );
        Ok(move || drop(subscription))
    })
    .await?;
    Ok(Box::new(feed))
}

// The wire's `/` list: the provider's commands and skills, and each working server's prompts under
// that server's name with the title it gives.
fn session_command_list(
    session_id: SessionId,
    list: ProviderCommandListResponse,
) -> SessionProviderCommandList {
    let mut commands = Vec::new();
    let mut server_prompts = Vec::new();
    for group in list.bindings.into_vec() {
        for entry in group.entries {
            match entry {
                ProviderCommandEntry::Prompt {
                    name,
                    description,
                    server,
                    title,
                    ..
                } => server_prompts.push(SessionServerPrompt {
                    server_name: server,
                    name: name.into(),
                    title,
                    description: description.map(ComposedText::from),
                }),
                command @ (ProviderCommandEntry::Command { .. }
                | ProviderCommandEntry::Skill { .. }) => commands.push(command),
            }
        }
    }
    SessionProviderCommandList {
        session_id,
        commands,
        server_prompts,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::capabilities::{DriverCapabilities, DriverCapabilityFlags};
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::test_registry::registry_of_first_provider;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_lead, test_session_id,
    };

    use super::follow_provider_commands;
    use crate::daemon::schema::schema_parts;
    use crate::ipc::handlers::driver::{DRIVER_METHODS_STATEMENT_CAPACITY, DriverMethodSources};

    // A `/` list follow on a provider that does not offer its command list is refused before the
    // driver is asked to follow anything. Killed by the capability gate moved after the subscribe.
    #[tokio::test]
    async fn a_command_list_follow_is_refused_before_the_driver_follows() {
        let database = TestDatabase::new(schema_parts());
        let schema = database.opener()().expect("the test creates its database");
        let session_id = test_session_id();
        insert_session_row(&schema, session_id.text().as_str(), None, None);
        insert_lead(&database, session_id, PROVIDERS[0].id);
        let mut driver = MockProviderDriver::new();
        driver.expect_subscribe_provider_commands().never();
        let providers = registry_of_first_provider(Arc::new(driver));
        providers
            .record_capabilities(
                &ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id"),
                DriverCapabilities {
                    flags: DriverCapabilityFlags::from_fn(|_| false),
                    contract_version: FreeFormText::new("1".to_owned()).expect("valid text"),
                },
            )
            .expect("the first provider is registered");
        let sources = DriverMethodSources {
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                DRIVER_METHODS_STATEMENT_CAPACITY,
            )),
            providers: Arc::new(providers),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        };

        let followed = follow_provider_commands(&sources, session_id).await;

        let Err(HandlerError::Refused(refusal)) = followed else {
            panic!("the follow is refused");
        };
        assert_eq!(refusal.code, RefusalCode::ProviderCapabilityUnsupported);
    }
}
