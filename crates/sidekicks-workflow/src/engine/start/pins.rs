//! The pins a run honors: hashed once at its start, carried on its started event inline within the
//! payload store's inline cap and past it as one stored payload, and read back from that event by
//! the restart and a retry.

use std::collections::HashMap;

use serde::de::Error as _;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::WorkflowPinnedItem;
use sidekicks_contracts::workflow::run::step::record::{
    WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP, WorkflowPayloadRef, WorkflowStepKey,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_store::events::canonicalizer::CanonicalizationRefusal;

use super::WorkflowRunStartError;
use super::stored_payloads::{StartPayloadError, StartPayloads};
use crate::definitions::content_hash::hash_canonical_json;
use crate::definitions::stored_document::parse_stored_pin_data;
use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::tick::RunPin;
use crate::runs::step_payload::{StepPayloadReadError, StepPayloadWriteError};

/// The pins a run's started event names: inline, or stored as one payload.
pub(crate) type StartedPins = (
    Option<Record<String, Vec<WorkflowPinnedItem>>>,
    Option<WorkflowPayloadRef>,
);

/// The pins a run of `mode` honors, each node's items with their content hash taken once here: the
/// stored `pin_data_json` parsed for a manual run, and none, unread, for any other. Refuses pins
/// that do not parse or whose items do not canonicalize.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) fn hash_run_pins(
    pin_data_json: Option<&str>,
    mode: WorkflowRunMode,
) -> Result<HashMap<WorkflowNodeId, RunPin>, WorkflowRunStartError> {
    if mode != WorkflowRunMode::Manual {
        return Ok(HashMap::new());
    }
    hash_pin_data(
        pin_data_json
            .map(parse_stored_pin_data)
            .transpose()?
            .unwrap_or_default(),
    )
}

/// The pins `pin_data` holds, each node's items with their content hash. Refuses items that do not
/// canonicalize.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) fn hash_pin_data(
    pin_data: Record<String, Vec<WorkflowPinnedItem>>,
) -> Result<HashMap<WorkflowNodeId, RunPin>, WorkflowRunStartError> {
    pin_data
        .into_map()
        .into_iter()
        // An empty key names no node, so no step gives its pin, as with a key naming a node the
        // version lacks.
        .filter_map(|(node_id, items)| Some((WorkflowNodeId::new(node_id)?, items)))
        .map(|(node_id, items)| {
            let hash = hash_canonical_json(
                &serde_json::to_value(&items).map_err(CanonicalizationRefusal::from)?,
            )?;
            Ok((node_id, RunPin { items, hash }))
        })
        .collect()
}

/// The pin data a run's start event stores for `pins`, the pins it honors; `None` for none.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) fn started_pin_data(
    pins: &HashMap<WorkflowNodeId, RunPin>,
) -> Option<Record<String, Vec<WorkflowPinnedItem>>> {
    if pins.is_empty() {
        return None;
    }
    let members = pins
        .iter()
        .map(|(node_id, pin)| (node_id.as_str().to_owned(), pin.items.clone()))
        .collect();
    Some(Record::new(members).expect("a pinned node's id is a stored record's key"))
}

/// The pins a run's started event carries for `pins`: inline at or under the inline cap's JSON
/// bytes, else stored through `stored` under the trigger step `trigger_step` as one payload,
/// recorded under the run as its start's other payloads are. Fails as the store or its record
/// fails.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) async fn started_pins(
    stored: &mut StartPayloads<'_>,
    trigger_step: &WorkflowStepKey,
    pins: &HashMap<WorkflowNodeId, RunPin>,
) -> Result<StartedPins, WorkflowRunStartError> {
    let Some(pin_data) = started_pin_data(pins) else {
        return Ok((None, None));
    };
    let measured_bytes =
        json_utf8_byte_length(&pin_data).map_err(WorkflowRunStartError::InputJson)?;
    if measured_bytes <= WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP {
        return Ok((Some(pin_data), None));
    }
    let bytes = serde_json::to_vec(&pin_data).map_err(WorkflowRunStartError::InputJson)?;
    let size_bytes = SafeInt::new(SafeInt::from_usize(bytes.len()).get())
        .expect("pins past the inline cap hold bytes");
    let item_count = SafeInt::from_usize(pin_data.as_map().len());
    let artifact_id = stored
        .store_bytes(trigger_step, bytes, item_count.get())
        .await
        .map_err(|error| match error {
            StartPayloadError::Write(StepPayloadWriteError::Json(error)) => {
                WorkflowRunStartError::InputJson(error)
            }
            StartPayloadError::Write(StepPayloadWriteError::Artifact(error)) => {
                WorkflowRunStartError::Payload(error)
            }
            StartPayloadError::Record(error) => WorkflowRunStartError::PayloadRecord(error),
        })?;
    Ok((
        None,
        Some(WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes,
            item_count,
        }),
    ))
}

/// The pins a started event carries, `pin_data` inline or `pin_data_ref` read back through
/// `payloads`; none where it carries neither. Fails with [`StepPayloadReadError::Artifact`] when
/// the stored pins do not read, and [`StepPayloadReadError::Json`] when they do not read as pins.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's restart and the workflow.run.retry handler"
    )
)]
pub(crate) async fn read_started_pins(
    payloads: &dyn StepPayloadArtifacts,
    (pin_data, pin_data_ref): StartedPins,
) -> Result<Record<String, Vec<WorkflowPinnedItem>>, StepPayloadReadError> {
    match pin_data_ref {
        None => Ok(pin_data.unwrap_or_default()),
        Some(WorkflowPayloadRef::Artifact { artifact_id, .. }) => {
            let bytes = payloads
                .read(&artifact_id)
                .await
                .map_err(StepPayloadReadError::Artifact)?;
            serde_json::from_slice(&bytes).map_err(StepPayloadReadError::Json)
        }
        Some(WorkflowPayloadRef::Inline { .. }) => Err(StepPayloadReadError::Json(
            serde_json::Error::custom("a start's stored pins name an artifact"),
        )),
    }
}
