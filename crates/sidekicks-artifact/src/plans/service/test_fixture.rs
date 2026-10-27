//! The plans service a test builds over the artifact test store, and the plan it takes.

use std::sync::Arc;

#[cfg(test)]
use serde_json::Value;
use sidekicks_contracts::plan::PlanId;
use sidekicks_provider::port::plan::ProviderPlan;

use super::PlansService;
use crate::test_store::ArtifactTestStore;

const PLAN_TEXT: &str = "# Ship the importer\n\n1. Read `src/import.rs`\n2. Write the tests\n";

/// The test store and the plans service over it.
pub struct Fixture {
    /// The artifact test store the plans are written to.
    pub store: ArtifactTestStore,
    /// The plans service over the store.
    pub plans: PlansService,
}

impl Fixture {
    /// Opens a fresh test store and the plans service over it.
    pub async fn new() -> Self {
        let store = ArtifactTestStore::open().await;
        let plans = PlansService::new(
            Arc::new(store.publisher()),
            Arc::clone(&store.appender),
            Arc::clone(&store.reads),
        );
        Self { store, plans }
    }

    /// Takes the test's plan, holding its request when `holds_request`.
    pub async fn take(&self, holds_request: bool) -> PlanId {
        self.plans
            .take_plan(ProviderPlan {
                session_id: self.store.session_id,
                run_id: self.store.run_id,
                text: PLAN_TEXT.to_owned(),
                plan_file_path: None,
                holds_request,
            })
            .await
            .expect("the plan is recorded")
    }

    /// The state `plan_id`'s row holds.
    #[cfg(test)]
    pub(crate) fn state(&self, plan_id: PlanId) -> String {
        self.store
            .read_rows(
                "SELECT state FROM plans WHERE id = ?1",
                plan_id.text().as_str(),
            )
            .remove(0)
    }

    /// The payloads of the log's events of `event_type`, oldest first.
    #[cfg(test)]
    pub(crate) fn payloads(&self, event_type: &str) -> Vec<Value> {
        self.store
            .read_rows(
                "SELECT payload FROM session_events WHERE type = ?1 ORDER BY sequence",
                event_type,
            )
            .iter()
            .map(|payload| serde_json::from_str(payload).expect("each payload is JSON"))
            .collect()
    }
}
