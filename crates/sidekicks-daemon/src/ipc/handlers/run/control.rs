//! A person's controls on a run: an intervention, a pause and a resume, and the answers to the
//! choices a provider holds a run on. A pause or a resume is refused by the run, then its version,
//! then its state, and only then by its driver; an answer by the run, then the choice it waits on,
//! then its driver. An intervention is refused only for an unknown run or a reused key: a guard it
//! fails ends it expired or rejected, and a dispatch that throws ends it failed. An intervention
//! and each answer record the device the call came from, and a pause or a resume records none.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::run::control::{
    AgentRunIntervene, AgentRunPause, AgentRunRefusalChoiceResolve, AgentRunResume,
    AgentRunUsageCreditsChoiceResolve,
};
use sidekicks_contracts::run::events::{InterventionActor, InterventionDeviceActor};

use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_provider::port::run_pause::ContinuedMessages;
use sidekicks_session::interventions::service::InterventionService;
use sidekicks_session::run::pause::RunPauseControl;
use sidekicks_session::run::provider_choice::{ProviderChoiceAnswerOrigin, ProviderChoiceResolver};

/// What the run control methods act through.
pub(crate) struct RunControlServices {
    /// Records, accepts and dispatches interventions.
    pub(crate) interventions: Arc<InterventionService>,
    /// Pauses and resumes runs.
    pub(crate) pauses: Arc<RunPauseControl>,
    /// Answers the choices a provider holds runs on.
    pub(crate) choices: Arc<ProviderChoiceResolver>,
    /// The messages waiting for a paused run, which its resume delivers.
    pub(crate) continued: Arc<dyn ContinuedMessages>,
}

/// The connection's device names the daemon itself, which no person's call can carry.
#[derive(Debug, thiserror::Error)]
#[error("the calling device names the daemon itself")]
struct CallingDeviceIsDaemon;

/// Registers `agent.run.intervene`, `agent.run.pause`, `agent.run.resume`,
/// `agent.run.refusalChoice.resolve` and `agent.run.usageCreditsChoice.resolve` over `services`.
/// Fails the start when one is already registered.
pub(crate) fn register_run_control(
    registry: &mut MethodRegistryBuilder,
    services: &RunControlServices,
) -> Result<(), RegistrationError> {
    let interventions = Arc::clone(&services.interventions);
    registry.register::<AgentRunIntervene, _>(move |request, context: HandlerContext| {
        let interventions = Arc::clone(&interventions);
        async move {
            let device_id = context.calling_device(AgentRunIntervene::DESCRIPTOR.method)?;
            let actor = InterventionDeviceActor::new(device_id)
                .ok_or_else(|| HandlerError::Internal(Box::new(CallingDeviceIsDaemon)))?;
            Ok(interventions
                .apply_intervention(request, InterventionActor::Device(actor))
                .await?)
        }
        .boxed()
    })?;
    let pauses = Arc::clone(&services.pauses);
    registry.register::<AgentRunPause, _>(move |request, _context: HandlerContext| {
        let pauses = Arc::clone(&pauses);
        async move { Ok(pauses.pause(&request).await?) }.boxed()
    })?;
    let pauses = Arc::clone(&services.pauses);
    let continued = Arc::clone(&services.continued);
    registry.register::<AgentRunResume, _>(move |request, _context: HandlerContext| {
        let pauses = Arc::clone(&pauses);
        let continued = Arc::clone(&continued);
        async move { Ok(pauses.resume(&request, continued.as_ref()).await?) }.boxed()
    })?;
    let choices = Arc::clone(&services.choices);
    registry.register::<AgentRunRefusalChoiceResolve, _>(
        move |request, context: HandlerContext| {
            let choices = Arc::clone(&choices);
            async move {
                let origin = ProviderChoiceAnswerOrigin {
                    device_id: context
                        .calling_device(AgentRunRefusalChoiceResolve::DESCRIPTOR.method)?,
                };
                Ok(choices.resolve_refusal_choice(&request, origin).await?)
            }
            .boxed()
        },
    )?;
    let choices = Arc::clone(&services.choices);
    registry.register::<AgentRunUsageCreditsChoiceResolve, _>(
        move |request, context: HandlerContext| {
            let choices = Arc::clone(&choices);
            async move {
                let origin = ProviderChoiceAnswerOrigin {
                    device_id: context
                        .calling_device(AgentRunUsageCreditsChoiceResolve::DESCRIPTOR.method)?,
                };
                Ok(choices
                    .resolve_usage_credits_choice(&request, origin)
                    .await?)
            }
            .boxed()
        },
    )
}
