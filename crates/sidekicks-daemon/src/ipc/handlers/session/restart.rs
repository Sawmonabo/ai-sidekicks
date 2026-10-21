//! `session.restart`: starts a session's provider process again after it ended and stayed down,
//! resuming its conversation through the provider's own resume. The driver clears its crash
//! count, announces the provider is back once it runs, and on a process several sessions share
//! brings back every session it held.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionRestart, SessionTargetRequest};

use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::provider::driver::capabilities::DriverCapabilityFlag;
use crate::provider::driver::contract::DriverResumeResult;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::session_control::ResumeSessionParams;
use crate::session::not_found::session_not_found;

/// The provider a session ran on, and its last binding rebuilt as the params of a resume.
pub(crate) struct SessionRestartTarget {
    /// The provider the session ran on.
    pub(crate) provider: ProviderId,
    /// The resume, rebuilt from the session's stored spawn record.
    pub(crate) params: ResumeSessionParams,
}

/// Reads a session's restart target: `None` for a session this daemon does not hold, or one with
/// no binding to resume from.
pub(crate) type RestartTargetReader = Arc<
    dyn Fn(SessionId) -> BoxFuture<'static, Result<Option<SessionRestartTarget>, HandlerError>>
        + Send
        + Sync,
>;

/// Registers `session.restart`. A session with no restart target is refused `session.notFound`,
/// a provider no driver answers `provider.notFound`, a driver that cannot resume
/// `provider.capability.unsupported` (the driver never called), a resume the provider refused for
/// its sign-in `provider.account.notAuthenticated`, and any other resume it could not make
/// `provider.unavailable`. Fails the start when the method is already registered.
pub(crate) fn register_session_restart(
    registry: &mut MethodRegistryBuilder,
    providers: Arc<ProviderRegistry>,
    read_target: RestartTargetReader,
) -> Result<(), RegistrationError> {
    registry.register::<SessionRestart, _>(
        move |request: SessionTargetRequest, _context: HandlerContext| {
            let providers = Arc::clone(&providers);
            let read_target = Arc::clone(&read_target);
            async move { restart(&providers, &read_target, request.session_id).await }.boxed()
        },
    )
}

async fn restart(
    providers: &ProviderRegistry,
    read_target: &RestartTargetReader,
    session_id: SessionId,
) -> Result<EmptyPayload, HandlerError> {
    let Some(target) = read_target(session_id).await? else {
        return Err(session_not_found(&session_id).into());
    };
    let driver = providers.lookup(&target.provider)?;
    providers.check_capability(&target.provider, DriverCapabilityFlag::Resume)?;
    match driver.restart_session(target.params).await? {
        DriverResumeResult::Resumed { .. } => Ok(EmptyPayload {}),
        DriverResumeResult::Failed {
            recovery_condition,
            provider_failure_detail,
        } => {
            let refusal = match recovery_condition {
                RecoveryCondition::ReauthRequired => DomainError::new(
                    "The provider refused the account's sign-in",
                    RefusalCode::ProviderAccountNotAuthenticated,
                )
                .with_detail(json!({
                    "providerId": target.provider,
                    "providerFailureDetail": provider_failure_detail,
                })),
                RecoveryCondition::RecoveryNeeded => DomainError::new(
                    "The provider could not restart the session",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({
                    "providerId": target.provider,
                    "recoveryCondition": recovery_condition,
                    "providerFailureDetail": provider_failure_detail,
                })),
            };
            Err(refusal.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::machine::settings::ProviderRowValues;
    use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::controls::methods::SessionMode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::{RestartTargetReader, SessionRestartTarget, restart};
    use crate::ipc::registry::HandlerError;
    use crate::provider::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use crate::provider::driver::contract::{
        DriverResumeResult, MockProviderDriver, ProviderDriver,
    };
    use crate::provider::driver::registry::ProviderRegistry;
    use crate::provider::driver::session_control::ResumeSessionParams;
    use crate::provider::driver::test_registry::test_driver_services;
    use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};

    const SESSION: &str = "0b7f3c1e-9a52-4d6b-8e21-5f4c7d9a1b30";

    /// What a case sets up before its one call.
    #[derive(Clone, Copy, Debug)]
    enum Setup {
        /// A session with no restart target, and no driver loaded.
        UnknownSession,
        /// A session whose provider no loaded driver answers.
        NoProvider,
        /// A session whose driver does not declare `resume`; the driver is never called.
        NoResume,
        /// A session whose driver's resume failed with this condition.
        ResumeFailed(RecoveryCondition),
    }

    /// A driver whose every restart fails with `condition`.
    fn failing_driver(condition: RecoveryCondition) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        driver.expect_restart_session().returning(move |_| {
            async move {
                Ok(DriverResumeResult::Failed {
                    recovery_condition: condition,
                    provider_failure_detail: FreeFormText::new("the process exited".to_owned())
                        .expect("the detail is valid text"),
                })
            }
            .boxed()
        });
        Arc::new(driver)
    }

    /// Builds a test's driver from the daemon's services.
    type BuildDriver = fn(&DriverServices) -> Arc<dyn ProviderDriver>;

    /// The registry of the table's first provider, built by `build`, with `resume` declared as
    /// `has_resume` says; or no provider at all when `build` is `None`.
    fn providers(build: Option<BuildDriver>, has_resume: bool) -> ProviderRegistry {
        let services = test_driver_services();
        let table: Vec<ProviderRegistration> = build
            .map(|build| ProviderRegistration {
                descriptor: PROVIDERS[0],
                build,
            })
            .into_iter()
            .collect();
        let registry = ProviderRegistry::register_from(&table, &services);
        if let Some(provider) = registry
            .drivers()
            .next()
            .map(|(provider, _)| provider.clone())
        {
            let capabilities = DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| {
                    has_resume && flag == DriverCapabilityFlag::Resume
                }),
                contract_version: FreeFormText::new("1".to_owned()).expect("valid text"),
            };
            registry
                .record_capabilities(&provider, capabilities)
                .expect("the provider is registered");
        }
        registry
    }

    /// A reader answering every session with a target on the table's first provider, or with none.
    fn targets(has_target: bool) -> RestartTargetReader {
        Arc::new(move |session_id: SessionId| {
            let target = has_target.then(|| SessionRestartTarget {
                provider: ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id"),
                params: ResumeSessionParams {
                    session_id,
                    resume_handle: "conversation".to_owned(),
                    model: FreeFormText::new("model".to_owned()).expect("valid text"),
                    larger_window: None,
                    mode: SessionMode::Build,
                    execution_posture: None,
                    output_speed: None,
                    options: Vec::new(),
                    row_values: ProviderRowValues::default(),
                    callback_tools: None,
                    subagent_policy: None,
                    tool_servers: None,
                    output_schema: None,
                    provider_account_id: None,
                    on_callback_tool_call: None,
                    on_mcp_server_status: None,
                },
            });
            async move { Ok(target) }.boxed()
        })
    }

    #[rstest]
    #[case::unknown_session(
        Setup::UnknownSession,
        RefusalCode::SessionNotFound,
        json!({ "sessionId": SESSION })
    )]
    #[case::no_provider(
        Setup::NoProvider,
        RefusalCode::ProviderNotFound,
        json!({ "providerId": PROVIDERS[0].id })
    )]
    #[case::no_resume(
        Setup::NoResume,
        RefusalCode::ProviderCapabilityUnsupported,
        json!({ "providerId": PROVIDERS[0].id, "flag": "resume" })
    )]
    #[case::resume_failed(
        Setup::ResumeFailed(RecoveryCondition::RecoveryNeeded),
        RefusalCode::ProviderUnavailable,
        json!({
            "providerId": PROVIDERS[0].id,
            "recoveryCondition": "recoveryNeeded",
            "providerFailureDetail": "the process exited",
        })
    )]
    #[case::sign_in_refused(
        Setup::ResumeFailed(RecoveryCondition::ReauthRequired),
        RefusalCode::ProviderAccountNotAuthenticated,
        json!({
            "providerId": PROVIDERS[0].id,
            "providerFailureDetail": "the process exited",
        })
    )]
    #[tokio::test]
    async fn the_address_is_refused_before_the_provider(
        #[case] setup: Setup,
        #[case] code: RefusalCode,
        #[case] fields: Value,
    ) {
        let session_id = SessionId::new(SESSION).expect("the id is a UUID");
        let refusal = match setup {
            Setup::UnknownSession => {
                match restart(&providers(None, false), &targets(false), session_id).await {
                    Err(HandlerError::Refused(refusal)) => refusal,
                    other => panic!("expected a refusal, got {:?}", other.err()),
                }
            }
            Setup::NoProvider => {
                match restart(&providers(None, true), &targets(true), session_id).await {
                    Err(HandlerError::Refused(refusal)) => refusal,
                    other => panic!("expected a refusal, got {:?}", other.err()),
                }
            }
            Setup::NoResume => {
                let registry = providers(Some(|_| Arc::new(MockProviderDriver::new())), false);
                match restart(&registry, &targets(true), session_id).await {
                    Err(HandlerError::Refused(refusal)) => refusal,
                    other => panic!("expected a refusal, got {:?}", other.err()),
                }
            }
            Setup::ResumeFailed(condition) => {
                let build: BuildDriver = match condition {
                    RecoveryCondition::RecoveryNeeded => {
                        |_| failing_driver(RecoveryCondition::RecoveryNeeded)
                    }
                    RecoveryCondition::ReauthRequired => {
                        |_| failing_driver(RecoveryCondition::ReauthRequired)
                    }
                };
                match restart(&providers(Some(build), true), &targets(true), session_id).await {
                    Err(HandlerError::Refused(refusal)) => refusal,
                    other => panic!("expected a refusal, got {:?}", other.err()),
                }
            }
        };
        assert_eq!(refusal.code, code, "{setup:?}");
        assert_eq!(
            Value::Object(refusal.detail.expect("the refusal carries fields")),
            fields,
            "{setup:?}"
        );
    }
}
