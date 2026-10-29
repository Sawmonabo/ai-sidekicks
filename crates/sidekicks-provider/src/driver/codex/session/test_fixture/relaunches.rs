//! The session directory's stand-in a test hands the driver's relaunches, which hears each
//! relaunch's opening and record, answers the legs a test hands it and refuses the step a test
//! names.

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::ports::SessionRelaunchListener;
use crate::driver::session_control::DriverResumeResult;
use crate::runtime_binding::resume::ResumeFunctionLegs;

/// Which step of each relaunch the session directory's stand-in refuses.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefusedRelaunchStep {
    /// None: every relaunch's opening and record are taken.
    Nothing,
    /// Every relaunch's opening.
    Opening,
    /// Every relaunch's record.
    Record,
}

/// The session directory's stand-in, telling `heard` of each relaunch's opening and record and
/// refusing the step `refused` names.
pub(crate) struct TakenRelaunches {
    /// Told `opened <binding>` at an opening, `legs <binding>` at a legs-only opening and
    /// `relaunched <binding, if resumed>` at a record.
    pub(crate) heard: Box<dyn Fn(String) + Send + Sync>,
    /// The step refused.
    pub(crate) refused: RefusedRelaunchStep,
    /// The legs each opening answers.
    pub(crate) legs: ResumeFunctionLegs,
}

impl SessionRelaunchListener for TakenRelaunches {
    fn open_relaunch_binding(
        &self,
        _session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> BoxFuture<'_, Result<ResumeFunctionLegs, Box<dyn std::error::Error + Send + Sync>>> {
        (self.heard)(format!("opened {binding_id:?}"));
        let is_refused = self.refused == RefusedRelaunchStep::Opening;
        let legs = self.legs.clone();
        async move {
            if is_refused {
                return Err("the test refuses the opening".into());
            }
            Ok(legs)
        }
        .boxed()
    }

    fn open_relaunch_legs(
        &self,
        _session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> BoxFuture<'_, Result<ResumeFunctionLegs, Box<dyn std::error::Error + Send + Sync>>> {
        (self.heard)(format!("legs {binding_id:?}"));
        let legs = self.legs.clone();
        async move { Ok(legs) }.boxed()
    }

    fn session_relaunched(
        &self,
        _session_id: SessionId,
        result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        let binding_id = match result {
            DriverResumeResult::Resumed { binding_id, .. } => Some(binding_id),
            DriverResumeResult::Failed { .. } => None,
        };
        (self.heard)(format!("relaunched {binding_id:?}"));
        let is_refused = self.refused == RefusedRelaunchStep::Record;
        async move {
            if is_refused {
                return Err("the test refuses the record".into());
            }
            Ok(())
        }
        .boxed()
    }
}
