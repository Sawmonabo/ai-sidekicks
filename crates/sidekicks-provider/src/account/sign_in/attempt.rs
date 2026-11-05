//! One sign-in attempt from its reservation to its end: the account's slot and home held while
//! its flow starts, the flow run to its one end, and the end settled into the registry.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use futures::StreamExt as _;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use sidekicks_contracts::provider::account::record::{
    BillingMode, CredentialGeneration, PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN, ProviderAccountId,
    ProviderAccountNotification, ProviderSignInOutcome,
};
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountSignInResponse, ProviderSignInArm,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::redaction::sanitize_sign_in_failure_reason;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use super::{
    AttemptId, AttemptServices, AttemptStage, FailureReason, InFlightGuard, ProviderSignInError,
    failure_reason_text,
};
use crate::account::credential_home::CredentialHome;
use crate::account::home_lock::SigningInMark;
use crate::account::registry::{AccountAdmission, MintedAccount, ProviderAccountRegistry};
use crate::driver::contract::account::{
    ProviderAccountLegs, ProviderSignInEnd, ProviderSignInHandle, ProviderSignInInput,
    ProviderSignInLegs,
};
use crate::driver::contract::error::bound_provider_words;

/// An account's sign-in slot and its listed attempt, held from the start until the attempt
/// settles. Every path that ends it before a row took its minted home has that home removed
/// first, signed out before it only where its flow showed an address (the settle), and dropped,
/// it unlists the attempt and frees the slot, so a failed or abandoned start leaves none of them.
pub(super) struct Reservation {
    /// The account held in flight until the attempt settles.
    pub(super) _in_flight_guard: InFlightGuard,
    /// The home's mark as signing in, from the flow's start until it ends.
    pub(super) signing_in: Option<SigningInMark>,
    /// What the attempt reaches beyond its flow.
    pub(super) services: AttemptServices,
    /// The attempt.
    pub(super) attempt_id: AttemptId,
    /// The account it signs in.
    pub(super) account_id: ProviderAccountId,
    /// The account's home.
    pub(super) home: CredentialHome,
    /// A new account's minted id and home, until a row takes it or it is removed.
    pub(super) minted: Option<MintedAccount>,
    /// A registered account's credential generation as its flow started, which its end must
    /// still find; `None` for a new account, whose home no one else knows.
    pub(super) started_generation: Option<CredentialGeneration>,
}

impl Reservation {
    // Takes the account's home once a renewal running there has ended, marks it as signing in,
    // notes a registered account's credential generation, starts the flow on `arm` in it, lets the
    // home go and answers `answer` whether the flow started, then runs the attempt to its end. A
    // caller that stopped waiting before the home was free, or the broker's stop meanwhile, starts
    // nothing; a caller that stopped after leaves the started flow to run to its end.
    pub(super) async fn run_attempt(
        mut self,
        legs: Arc<dyn ProviderSignInLegs>,
        arm: ProviderSignInArm,
        mut answer: oneshot::Sender<Result<ProviderAccountSignInResponse, ProviderSignInError>>,
    ) {
        let home_lock = Arc::clone(&self.services.home_lock);
        let stopping = self.services.stopping.clone();
        // The stop is checked first, so a start that arrives after it starts nothing.
        let hold = tokio::select! {
            biased;
            () = stopping.cancelled() => {
                self.release().await;
                return;
            }
            () = answer.closed() => {
                self.release().await;
                return;
            }
            hold = home_lock.hold(self.account_id.clone()) => hold,
        };
        self.signing_in = Some(home_lock.mark_signing_in(self.account_id.clone()));
        if self.minted.is_none() {
            let read = self.services.registry.read(self.account_id.clone()).await;
            match read {
                Ok(account) => self.started_generation = Some(account.credential_generation),
                Err(error) => {
                    self.release().await;
                    drop(hold);
                    let _unheard = answer.send(Err(error.into()));
                    return;
                }
            }
        }
        let started = legs
            .start_sign_in(self.account_id.clone(), self.home.clone(), arm)
            .await;
        drop(hold);
        let ProviderSignInHandle {
            verification_uri,
            user_code,
            expires_at,
            is_browser_opened_by_provider,
            code_prompts,
            input,
            completion,
        } = match started {
            Ok(handle) => handle,
            Err(error) => {
                // Freed first, so the caller finds no slot and no minted home left. A start that
                // failed showed no address, so no sign-in reached the home and none is signed out.
                self.release().await;
                let _unheard = answer.send(Err(error.into()));
                return;
            }
        };
        let input: Arc<dyn ProviderSignInInput> = Arc::from(input);
        let (attempt, is_cancel_asked) = self.open(Arc::clone(&input));
        let publisher = Arc::clone(&attempt.reservation.services.publisher);
        let _unheard = answer.send(Ok(ProviderAccountSignInResponse {
            attempt_id: attempt.reservation.attempt_id.clone(),
            verification_uri,
            user_code,
            expires_at,
            is_browser_opened_by_provider,
        }));
        if is_cancel_asked && let Err(error) = input.cancel().await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a sign-in canceled while it started was not canceled"
            );
        }
        let ended = attempt.run(legs, input, code_prompts, completion).await;
        publisher.publish(ended);
    }

    // Removes the minted home no row took with no sign-out, since no flow showed its address, then
    // unlists the attempt and frees the slot.
    pub(super) async fn release(mut self) {
        if let Some(minted) = self.minted.take() {
            abandon(&self.services.registry, minted, None).await;
        }
    }

    // Hands the listed attempt its flow's input, so a code submit and a cancel reach it, with
    // whether a cancel was asked while the flow started.
    fn open(self, input: Arc<dyn ProviderSignInInput>) -> (Attempt, bool) {
        let stage = AttemptStage::Open {
            input,
            is_waiting_for_code: false,
        };
        let started = std::mem::replace(
            &mut lock(&self.services.attempts)
                .attempts
                .get_mut(&self.attempt_id)
                .expect("an attempt listed at its reservation stays listed until it settles")
                .stage,
            stage,
        );
        let is_cancel_asked = matches!(
            started,
            AttemptStage::Starting {
                is_cancel_asked: true
            }
        );
        (Attempt { reservation: self }, is_cancel_asked)
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        lock(&self.services.attempts)
            .attempts
            .remove(&self.attempt_id);
    }
}

/// An open attempt, run to its one end on its own task; its reservation frees the account's slot
/// once the attempt has settled.
struct Attempt {
    reservation: Reservation,
}

impl Attempt {
    // Reports each wait for a code until the flow ends, canceling it through `input` once the
    // broker stops, then settles the account and answers the end's notification.
    async fn run(
        mut self,
        legs: Arc<dyn ProviderSignInLegs>,
        input: Arc<dyn ProviderSignInInput>,
        mut code_prompts: BoxStream<'static, ()>,
        mut completion: BoxFuture<'static, ProviderSignInEnd>,
    ) -> ProviderAccountNotification {
        let stopping = self.reservation.services.stopping.clone();
        let mut is_stop_sent = false;
        let end = loop {
            tokio::select! {
                biased;
                end = &mut completion => break end,
                () = stopping.cancelled(), if !is_stop_sent => {
                    is_stop_sent = true;
                    if let Err(error) = input.cancel().await {
                        tracing::warn!(
                            error = &error as &(dyn Error + 'static),
                            "a sign-in the daemon's stop canceled was not canceled"
                        );
                    }
                }
                Some(()) = code_prompts.next() => self.mark_waiting_for_code(),
            }
        };
        // The flow has ended, so a renewal may run in the home again once its hold is free.
        drop(self.reservation.signing_in.take());
        // Settling from the flow's end: no code submit or cancel reaches it and it no longer holds
        // the machine's one slot, while a start on its account meets it by name until it settles.
        {
            let mut live = lock(&self.reservation.services.attempts);
            let attempt = live
                .attempts
                .get_mut(&self.reservation.attempt_id)
                .expect("an attempt listed at its reservation stays listed until it settles");
            attempt.is_one_per_machine = false;
            attempt.stage = AttemptStage::Settling;
        }
        let (outcome, failure_reason) = self.settle(legs.as_ref(), end).await;
        let Self { reservation } = self;
        let attempt_id = reservation.attempt_id.clone();
        let account_id = reservation.account_id.clone();
        drop(reservation);
        ProviderAccountNotification::SignInCompleted {
            attempt_id,
            account_id,
            outcome,
            failure_reason,
        }
    }

    fn mark_waiting_for_code(&self) {
        let services = &self.reservation.services;
        let attempt_id = &self.reservation.attempt_id;
        let is_live = match lock(&services.attempts)
            .attempts
            .get_mut(attempt_id)
            .map(|attempt| &mut attempt.stage)
        {
            Some(AttemptStage::Open {
                is_waiting_for_code,
                ..
            }) => {
                *is_waiting_for_code = true;
                true
            }
            Some(AttemptStage::Starting { .. } | AttemptStage::Settling) | None => false,
        };
        if is_live {
            services
                .publisher
                .publish(ProviderAccountNotification::SignInCodeRequested {
                    attempt_id: attempt_id.clone(),
                });
        }
    }

    // Takes the status read after a finished flow and writes what it found; a new account that
    // ends any other way has its minted home signed out and removed, as its flow showed an address.
    // A failed flow's reason is the provider's own words where it gave any, every address, code
    // and credential in them replaced first.
    async fn settle(
        &mut self,
        legs: &dyn ProviderSignInLegs,
        end: ProviderSignInEnd,
    ) -> (ProviderSignInOutcome, Option<FailureReason>) {
        let settled = match end {
            ProviderSignInEnd::Finished => {
                let (outcome, reason) = self.observe(legs).await;
                (outcome, reason.map(failure_reason_text))
            }
            ProviderSignInEnd::Failed { reason } => (
                ProviderSignInOutcome::Failed,
                Some(
                    reason
                        .and_then(|words| {
                            bound_provider_words(&sanitize_sign_in_failure_reason(
                                words.as_str(),
                                PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN,
                            ))
                        })
                        .unwrap_or_else(|| failure_reason_text("The sign-in did not finish")),
                ),
            ),
            ProviderSignInEnd::Expired => (ProviderSignInOutcome::Expired, None),
            ProviderSignInEnd::Canceled => (ProviderSignInOutcome::Canceled, None),
        };
        if let Some(minted) = self.reservation.minted.take() {
            let services = &self.reservation.services;
            abandon(&services.registry, minted, Some(&*services.account_legs)).await;
        }
        settled
    }

    // Reads who signed in and stores it under the home's hold: a new account's row only where the
    // provider named it, with billing `unknown` and the kind of sign-in read, and a registered
    // account's reading and kind always, unless its credential generation moved since the flow
    // started, publishing the row written. A written row takes the minted account, so its home
    // stays.
    async fn observe(
        &mut self,
        legs: &dyn ProviderSignInLegs,
    ) -> (ProviderSignInOutcome, Option<&'static str>) {
        let reservation = &mut self.reservation;
        let home_lock = Arc::clone(&reservation.services.home_lock);
        let hold = home_lock.hold(reservation.account_id.clone()).await;
        let observation = match legs
            .observe_sign_in(reservation.account_id.clone(), reservation.home.clone())
            .await
        {
            Ok(observation) => observation,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the status read after a sign-in failed"
                );
                return (
                    ProviderSignInOutcome::Failed,
                    Some("The account could not be checked after the sign-in"),
                );
            }
        };
        let registry = &reservation.services.registry;
        if let Some(started_generation) = reservation.started_generation {
            match registry.read(reservation.account_id.clone()).await {
                Ok(account) if account.credential_generation == started_generation => {}
                Ok(_) => {
                    return (
                        ProviderSignInOutcome::Failed,
                        Some("The account changed during the sign-in"),
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a signed-in account was not read before its sign-in was saved"
                    );
                    return (
                        ProviderSignInOutcome::Failed,
                        Some("The account could not be saved after the sign-in"),
                    );
                }
            }
        }
        let written = match &reservation.minted {
            Some(_) if !observation.is_account_named => None,
            Some(minted) => Some(
                registry
                    .admit(
                        minted,
                        &AccountAdmission {
                            display_label: None,
                            billing_mode: BillingMode::Unknown,
                            health: Some(observation.health),
                            observed_auth_mode: observation.observed_auth_mode,
                        },
                    )
                    .await
                    .map(|_| ()),
            ),
            None => Some(
                registry
                    .record_sign_in(
                        &reservation.account_id,
                        &observation.health,
                        observation.observed_auth_mode,
                    )
                    .await
                    .map(|_| ()),
            ),
        };
        drop(hold);
        let changed = match &written {
            Some(Ok(())) => {
                if observation.is_account_named {
                    reservation.minted = None;
                }
                match registry.read(reservation.account_id.clone()).await {
                    Ok(account) => Some(account),
                    Err(error) => {
                        tracing::warn!(
                            error = &error as &(dyn Error + 'static),
                            "a signed-in account was not read, so it is not published or observed \
                             until the next start"
                        );
                        None
                    }
                }
            }
            Some(Err(_)) | None => None,
        };
        if let Some(account) = &changed {
            reservation
                .services
                .publisher
                .publish(ProviderAccountNotification::AccountChanged {
                    account: account.to_provider_account(),
                });
        }
        match written {
            Some(Ok(())) if observation.is_account_named => {
                if let Some(account) = &changed {
                    reservation.services.watcher.watch_signed_in(account);
                }
                (ProviderSignInOutcome::Succeeded, None)
            }
            Some(Ok(())) | None => (
                ProviderSignInOutcome::Failed,
                Some("The provider did not name the account"),
            ),
            Some(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a sign-in's account was not saved"
                );
                (
                    ProviderSignInOutcome::Failed,
                    Some("The account could not be saved after the sign-in"),
                )
            }
        }
    }
}

/// Has the home of an account no sign-in admitted signed out through its provider's entry in
/// `legs`, where they are given, and removed, keeping a failure in the service log.
pub(super) async fn abandon(
    registry: &ProviderAccountRegistry,
    minted: MintedAccount,
    legs: Option<&HashMap<ProviderId, Arc<dyn ProviderAccountLegs>>>,
) {
    if let Err(error) = registry.abandon(minted, legs).await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a sign-in's minted home kept its mark; the next start clears it"
        );
    }
}
