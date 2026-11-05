//! The run engine as the drivers' run host: each call a driver makes through its port, its
//! failure handed over whole but a daemon turn refused for a held turn or by its binding, which
//! reaches the driver typed, and the stored leg a driver reads read through the engine's pool.

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::run_control::DaemonTurnBindingError;
use sidekicks_provider::port::run_host::{DaemonTurnHeld, RunHost, RunHostError};
use sidekicks_provider::run::start_request::DaemonTurnStartRequest;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, StartedTurn, TurnOutcome};
use sidekicks_provider::runtime_binding::store::RuntimeBinding;

use crate::run::daemon_turn::DaemonTurnQueueError;
use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::refusals::RunRefusal;
use crate::run::stored_leg::read_session_leg;

impl RunHost for RunEngine {
    fn start_turn(
        &self,
        run_id: RunId,
        provider_turn_id: Option<ProviderTurnId>,
        step_bound: Option<SafeInt<1>>,
        opening: Option<QueueItemId>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunHostError>> {
        async move {
            Ok(
                RunEngine::start_turn(self, run_id, None, provider_turn_id, step_bound, opening)
                    .await?,
            )
        }
        .boxed()
    }

    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        let engine = self.shared();
        async move { Ok(engine.count_step(run_id).await?) }.boxed()
    }

    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunHostError>> {
        let engine = self.shared();
        async move {
            let written = engine.record_turn_end(run_id, turn_end).await?;
            Ok(written.log_resend_failure(run_id))
        }
        .boxed()
    }

    fn record_daemon_turn_end(
        &self,
        run_id: RunId,
        turn_number: SafeInt<1>,
        outcome: TurnOutcome,
    ) -> BoxFuture<'_, Result<bool, RunHostError>> {
        async move {
            Ok(RunEngine::record_daemon_turn_end(self, run_id, turn_number, outcome).await?)
        }
        .boxed()
    }

    fn record_settled_output_speed(
        &self,
        session_id: SessionId,
        run_id: RunId,
        state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        async move {
            Ok(RunEngine::record_settled_output_speed(self, session_id, run_id, &state).await?)
        }
        .boxed()
    }

    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunHostError>> {
        async move {
            RunEngine::start_daemon_turn(self, request)
                .await
                .map_err(daemon_turn_failure)
        }
        .boxed()
    }

    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        async move { Ok(RunEngine::end_turn_on_process_exit(self, run_id, process_exit).await?) }
            .boxed()
    }

    fn end_turn_on_close(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        async move { Ok(RunEngine::end_turn_on_close(self, run_id).await?) }.boxed()
    }

    fn read_session_leg(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<RuntimeBinding>, RunHostError>> {
        async move { Ok(read_session_leg(&self.pool, session_id).await?) }.boxed()
    }
}

// A daemon turn refused because the session's turn is held reaches the driver as
// [`DaemonTurnHeld`], and one its binding refused, or found no process for, as that
// [`DaemonTurnBindingError`], so it can tell either from a failure; any other error goes whole.
fn daemon_turn_failure(error: RunEngineError) -> RunHostError {
    if let RunEngineError::DaemonTurn(queue_error) = &error
        && let DaemonTurnQueueError::Refused(RunRefusal::SessionTurnHeld { session_id, .. }) =
            &**queue_error
    {
        return Box::new(DaemonTurnHeld {
            session_id: *session_id,
        });
    }
    let RunEngineError::Driver { run_id, source } = error else {
        return Box::new(error);
    };
    match source.downcast::<DaemonTurnBindingError>() {
        Ok(binding)
            if matches!(
                *binding,
                DaemonTurnBindingError::Refused { .. }
                    | DaemonTurnBindingError::NoProviderSession { .. }
            ) =>
        {
            binding as RunHostError
        }
        Ok(binding) => Box::new(RunEngineError::Driver {
            run_id,
            source: binding,
        }),
        Err(source) => Box::new(RunEngineError::Driver { run_id, source }),
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_provider::driver::run_control::DaemonTurnBindingError;
    use sidekicks_provider::driver::test_registry::new_run_id;
    use sidekicks_provider::port::run_host::DaemonTurnHeld;

    use super::daemon_turn_failure;
    use crate::run::daemon_turn::DaemonTurnQueueError;
    use crate::run::engine::errors::RunEngineError;
    use crate::run::refusals::RunRefusal;

    // Killed by handing the held refusal, the binding's, or its missing process over as the
    // engine's own error, which the driver can only read as a failure, by typing any other error
    // as held, and by handing a binding's fault over bare.
    #[test]
    fn a_daemon_turn_refused_for_a_held_turn_or_by_its_binding_reaches_the_driver_typed() {
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let held =
            RunEngineError::from(DaemonTurnQueueError::Refused(RunRefusal::SessionTurnHeld {
                session_id,
                source: Box::new(io::Error::other("a lead run is live")),
            }));

        let typed = daemon_turn_failure(held);
        assert_eq!(
            typed
                .downcast_ref::<DaemonTurnHeld>()
                .map(|held| held.session_id),
            Some(session_id)
        );

        let unread = daemon_turn_failure(RunEngineError::Read(Box::new(
            rusqlite::Error::QueryReturnedNoRows,
        )));
        assert!(unread.downcast_ref::<DaemonTurnHeld>().is_none());
        assert!(matches!(
            unread.downcast_ref::<RunEngineError>(),
            Some(RunEngineError::Read(_))
        ));

        let closed = daemon_turn_failure(RunEngineError::Driver {
            run_id: new_run_id(),
            source: Box::new(DaemonTurnBindingError::Refused {
                session_id,
                refusal: Box::new(DomainError::new(
                    "the session is closed",
                    RefusalCode::SessionAlreadyClosed,
                )),
            }),
        });
        assert!(matches!(
            closed.downcast_ref::<DaemonTurnBindingError>(),
            Some(DaemonTurnBindingError::Refused { refusal, .. })
                if refusal.code == RefusalCode::SessionAlreadyClosed
        ));

        let let_go = daemon_turn_failure(RunEngineError::Driver {
            run_id: new_run_id(),
            source: Box::new(DaemonTurnBindingError::NoProviderSession { session_id }),
        });
        assert!(matches!(
            let_go.downcast_ref::<DaemonTurnBindingError>(),
            Some(DaemonTurnBindingError::NoProviderSession { .. })
        ));

        let unadmitted = daemon_turn_failure(RunEngineError::Driver {
            run_id: new_run_id(),
            source: Box::new(DaemonTurnBindingError::NotAdmitted {
                session_id,
                source: Box::new(io::Error::other("no place at the memory gate")),
            }),
        });
        assert!(matches!(
            unadmitted.downcast_ref::<RunEngineError>(),
            Some(RunEngineError::Driver { .. })
        ));
    }
}
