//! The provider build retirement's job: the one retirement armed on the wall clock's timer, which
//! fires across sleep, and the retry of a job a refused timer or a failed retirement left empty, a
//! minute later on the monotonic clock and again each minute while it keeps failing.

use std::error::Error;
use std::sync::Arc;
use std::time::SystemTime;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use sidekicks_std::scheduler::armed_instant::{ArmedInstant, InstantJob};
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::attention::retention::next_provider_build_retirement;
use crate::attention::service::{AttentionService, AttentionServiceError};

/// The retirement's job name, as the program's log names it.
pub(super) const PROVIDER_BUILD_RETIREMENT_JOB: &str = "attention provider build retirement";

/// The retry's job name, as the program's log names it.
pub(super) const PROVIDER_BUILD_RETIREMENT_RETRY_JOB: &str =
    "attention provider build retirement retry";

impl InstantJob for AttentionService {
    fn armed_instant(&self) -> &ArmedInstant {
        &self.retirement
    }

    fn fire(
        self: Arc<Self>,
        instant: SystemTime,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let retires_at = Timestamp::try_from(instant)
                .expect("a retirement is armed at an instant read from a timestamp");
            Ok(self.advance_retention(Vec::new(), retires_at).await?)
        }
        .boxed()
    }

    fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()> {
        async move { self.arm_provider_build_retirement().await }.boxed()
    }
}

impl AttentionService {
    /// Arms the next provider build line's retirement on the wall clock's timer in place of the
    /// one armed; a failed read schedules the retry while none is armed. Boxed, since a fired
    /// retirement's advance awaits it in turn.
    pub(super) fn arm_provider_build_retirement(self: &Arc<Self>) -> BoxFuture<'_, ()> {
        async move {
            match self
                .pool
                .read(ReadLength::Short, |connection| {
                    Ok::<_, AttentionServiceError>(next_provider_build_retirement(connection)?)
                })
                .await
            {
                Ok(next) => ArmedInstant::arm(self, next.map(SystemTime::from)),
                Err(error) => ArmedInstant::retry_while_empty(self, &error),
            }
        }
        .boxed()
    }
}
