//! Where a driver hands a plan its agent finished, so the plan record is written from the
//! provider's own text, and reports the end of a provider request it held for the plan's verdict.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// A plan as its provider sent it, never read off the disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderPlan {
    /// The id the driver minted before handing the plan over, which the record is written under.
    pub plan_id: PlanId,
    /// The session.
    pub session_id: SessionId,
    /// The run that proposed it.
    pub run_id: RunId,
    /// The plan's markdown.
    pub text: String,
    /// Where the provider wrote the plan as a file, where it did.
    pub plan_file_path: Option<FilesystemPath>,
    /// Whether the driver holds a provider request that waits on the verdict.
    pub holds_request: bool,
}

/// Mints a new plan's id, which its driver sets on the plan before handing it over.
pub fn mint_plan_id() -> PlanId {
    PlanId::try_from(mint_uuid_v7()).expect("a minted UUIDv7 is a plan id")
}

/// A held plan request the provider let go before any verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderPlanHoldEnd {
    /// The session.
    pub session_id: SessionId,
    /// The plan whose request was held.
    pub plan_id: PlanId,
    /// Why the hold ended.
    pub reason: PlanHoldEndedReason,
}

/// The plan record's intake, registered through a `PortRegistration`. A plan that cannot reach
/// it, unregistered or failing to record, is refused at its provider at once and records nothing.
pub trait PlanPort: Send + Sync {
    /// Records `plan` under its `plan_id`. An error when it could not be recorded.
    fn take_plan(
        &self,
        plan: ProviderPlan,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Reopens a waiting plan whose held request ended; one whose request is not held, or that is
    /// settled, stays as it is. An error when the record could not be written.
    fn end_plan_hold(
        &self,
        hold_end: ProviderPlanHoldEnd,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
