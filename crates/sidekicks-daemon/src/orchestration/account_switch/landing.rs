//! A moved lead's landing on its new account: its `agent.providerBinding.changed` or
//! `changeFailed` settlement, its level moved where the new account cannot run it, and the watch of
//! its first request there, which records a hand-back.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingContinuity, AgentBindingSwitchAccountState, AgentBindingSwitchFailureReason,
    AgentBindingSwitchTarget, AgentProviderBindingChangeFailedPayload,
    AgentProviderBindingChangedPayload,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_provider::driver::contract::account::FirstRequestAfterMove;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_session::run::agent::SessionLead;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};

use super::{AccountSwitch, LandingLead};
use crate::orchestration::binding_switch::{account_state_of, mint_switch_id};

impl AccountSwitch {
    // A lead whose move landed on `to`, a switch's or one a driver reported: its settlement by
    // `actor`, then its level moved where `to` cannot run it; answers the watch of its first
    // request there, which records a hand-back.
    pub(super) async fn land(
        self: &Arc<Self>,
        lead: LandingLead,
        to: ProviderAccountId,
        actor: DeviceId,
        first_request: BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>>,
    ) -> BoxFuture<'static, ()> {
        self.record_changed(&lead, &to, &actor).await;
        self.move_level_where_unavailable(&lead, &to).await;
        Arc::clone(self).watch_first_request(lead, to, actor, first_request)
    }

    // Waits for a moved lead's first request on `to`: one the provider refused for the new
    // account's login was handed the previous account back, which one `changeFailed` records. A
    // hand-back that could not be made leaves the session on `to`, whose login is gone, so it is
    // the same failure to the person, and its cause is logged.
    fn watch_first_request(
        self: Arc<Self>,
        lead: LandingLead,
        to: ProviderAccountId,
        actor: DeviceId,
        first_request: BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>>,
    ) -> BoxFuture<'static, ()> {
        async move {
            match first_request.await {
                Ok(FirstRequestAfterMove::Ran | FirstRequestAfterMove::Unobserved) => return,
                Ok(FirstRequestAfterMove::HandedBack) => {}
                Err(error) => tracing::warn!(
                    session_id = %lead.session_id,
                    error = &error as &(dyn Error + 'static),
                    "a refused login after an account switch could not be handed back"
                ),
            }
            self.record_failed_with(
                &lead,
                &to,
                &actor,
                AgentBindingSwitchAccountState::ReauthRequired,
            )
            .await;
        }
        .boxed()
    }

    pub(super) async fn record_changed(
        &self,
        lead: &LandingLead,
        to: &ProviderAccountId,
        actor: &DeviceId,
    ) {
        append_settlement(
            &self.deps.appender,
            lead.session_id,
            &binding_changed(lead.session_id, &lead.lead, to, actor),
        )
        .await;
    }

    pub(super) async fn record_failed(
        &self,
        lead: &LandingLead,
        to: &ProviderAccountId,
        actor: &DeviceId,
        error: &DriverError,
    ) {
        tracing::warn!(
            session_id = %lead.session_id,
            error = error as &(dyn Error + 'static),
            "a session was not moved onto the account made current"
        );
        self.record_failed_with(lead, to, actor, account_state_of(error))
            .await;
    }

    pub(super) async fn record_failed_with(
        &self,
        lead: &LandingLead,
        to: &ProviderAccountId,
        actor: &DeviceId,
        account_state: AgentBindingSwitchAccountState,
    ) {
        let session_id = lead.session_id;
        append_settlement(
            &self.deps.appender,
            session_id,
            &SessionEvent::AgentProviderBindingChangeFailed(
                AgentProviderBindingChangeFailedPayload {
                    switch_id: mint_switch_id(),
                    reason: AgentBindingSwitchFailureReason::AccountUnavailable,
                    account_state: Some(account_state),
                    session_id,
                    agent_id: lead.lead.agent_id,
                    actor: actor.clone(),
                    from: lead.lead.binding.clone(),
                    // An account move sets only the account.
                    attempted: AgentBindingSwitchTarget {
                        provider_name: None,
                        model_id: None,
                        provider_account_id: Some(to.clone()),
                        effort: None,
                        output_speed: None,
                        options: None,
                        larger_window: None,
                    },
                },
            ),
        )
        .await;
    }
}

// `agent.providerBinding.changed` for `session_id`'s `lead`, landed on `to` by `actor`.
fn binding_changed(
    session_id: SessionId,
    lead: &SessionLead,
    to: &ProviderAccountId,
    actor: &DeviceId,
) -> SessionEvent {
    let from = lead.binding.clone();
    SessionEvent::AgentProviderBindingChanged(AgentProviderBindingChangedPayload {
        switch_id: mint_switch_id(),
        declared_losses: Vec::new(),
        continuity: AgentBindingContinuity::InPlace,
        session_id,
        agent_id: lead.agent_id,
        actor: actor.clone(),
        // The lead still follows the current account: only where it landed moved.
        to: from.clone(),
        from,
        landed_provider_account_id: to.clone(),
    })
}

// Appends `event` to `session_id`'s log through `appender`; a failure is logged, since no caller is
// left to answer by then.
pub(super) async fn append_settlement(
    appender: &SessionEventAppender,
    session_id: SessionId,
    event: &SessionEvent,
) {
    let appended = match SessionEventDraft::of_session(session_id, event) {
        Ok(draft) => appender
            .append(draft, SessionEventLinkage::default())
            .await
            .map(|_receipt| ())
            .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>),
        Err(error) => Err(Box::new(error) as Box<dyn Error + Send + Sync>),
    };
    if let Err(error) = appended {
        tracing::warn!(
            %session_id,
            error = &*error as &(dyn Error + 'static),
            "an account move's settlement was not appended"
        );
    }
}
