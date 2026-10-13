//! Which run an event payload names. It reads the open record every event carries, so the
//! daemon's projection and any client reading raw events file a row under the same run, and fold
//! the same events into a run's own facts.

use serde_json::{Map, Value};

use crate::typescript::TypeScriptModule;

/// The payload keys that name a run: `runId` everywhere, and `targetRunId` on interventions. Both
/// are read, since a guard reading only `runId` would let intervention rows through the `general`
/// arm.
pub const TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS: [&str; 2] = ["runId", "targetRunId"];

/// The run a payload belongs to: the first non-empty string among `runId` and `targetRunId`, or
/// `None` when it names none. An event belongs to a run exactly when this answers a run id.
pub fn transcript_run_id_of(payload: Option<&Map<String, Value>>) -> Option<&str> {
    TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS
        .iter()
        .find_map(|payload_key| run_id_at(payload, payload_key))
}

/// The run a payload names as its own, by `runId` alone. An intervention's `targetRunId` files its
/// row under the run it targets but is not that run's own event.
pub fn transcript_own_run_id_of(payload: Option<&Map<String, Value>>) -> Option<&str> {
    run_id_at(payload, "runId")
}

/// The non-empty string `payload` holds at `payload_key`.
fn run_id_at<'payload>(
    payload: Option<&'payload Map<String, Value>>,
    payload_key: &str,
) -> Option<&'payload str> {
    payload?
        .get(payload_key)?
        .as_str()
        .filter(|run_id| !run_id.is_empty())
}

/// The module has no TypeScript face: the client keeps its own copy of these readers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/run-attribution",
    doc: "Which run an event payload names.",
    definitions: &[],
    constants: &[],
    method_tables: &[],
};
