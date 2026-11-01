//! The Codex leg of the output-speed axis: the service tier a thread and each turn carry, resolved
//! against the model's catalog row so a level the model does not list runs at standard; the tier
//! the thread declares back; and the per-run report of the tier each turn settled at.

use std::future::Future;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::declared_output_speed::{DeclaredOutputSpeed, read_declared_output_speed};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::capabilities::find_codex_model_row;
use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_STARTED_METHOD, CODEX_THREAD_SETTINGS_UPDATED_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::driver::codex::session::state::{CodexSessionRecord, CodexUnsettledOutputSpeedRun};
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::contract::error::DriverError;

/// The tier one run settled at, for the run engine to compare with the level it asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexSettledOutputSpeed {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// The account the session runs on.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The tier the thread declared.
    pub(crate) state: ProviderOutputSpeedState,
}

/// A reply or settings notice member that may carry `serviceTier`, absent, `null` or a tier.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceTierCarrier {
    #[serde(default, with = "serde_with::rust::double_option")]
    #[expect(
        clippy::option_option,
        reason = "a reply with no tier declares nothing, where a `null` tier declares standard"
    )]
    service_tier: Option<Option<Value>>,
}

/// The members of a frame the speed report reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeedFrame {
    thread_id: Option<String>,
    turn_id: Option<String>,
    thread_settings: Option<Box<RawValue>>,
    turn: Option<SpeedFrameTurn>,
}

#[derive(Deserialize)]
struct SpeedFrameTurn {
    id: Option<String>,
}

/// The `serviceTier` member a thread or turn request carries for `level`: none with no level held,
/// so Codex keeps its own tier; `null` for standard, the wire's way to clear the tier, since an
/// omitted member leaves it unchanged; otherwise the tier id itself.
#[expect(
    clippy::option_option,
    reason = "absent, `null` and a tier are three meanings the wire keeps apart"
)]
pub(crate) fn compose_codex_service_tier(level: Option<&str>) -> Option<Option<String>> {
    level.map(|level| (level != DESCRIPTOR.standard_output_speed).then(|| level.to_owned()))
}

/// The level a carried `level` runs at on `model`: itself where the catalog `read_catalog` reads
/// lists it for that model, else standard, so no carried level is refused and none the model lacks
/// is sent. Standard and an absent level read no catalog. Fails as the catalog read does.
pub(crate) async fn resolve_codex_output_speed_level<CatalogRead>(
    read_catalog: impl FnOnce() -> CatalogRead,
    model: &str,
    level: Option<String>,
) -> Result<Option<String>, DriverError>
where
    CatalogRead: Future<Output = Result<Vec<ProviderModel>, DriverError>>,
{
    let Some(level) = level else {
        return Ok(None);
    };
    if level == DESCRIPTOR.standard_output_speed {
        return Ok(Some(level));
    }
    let catalog = read_catalog().await?;
    let is_listed = find_codex_model_row(&catalog, model)
        .and_then(|row| row.output_speed_levels.as_ref())
        .is_some_and(|levels| levels.iter().any(|listed| listed.as_str() == level));
    Ok(Some(if is_listed {
        level
    } else {
        DESCRIPTOR.standard_output_speed.to_owned()
    }))
}

/// The tier a `thread/start`, `thread/resume` or `thread/fork` reply declares; `None` when the
/// reply carries no `serviceTier` member or one the contract's bounds refuse, which is reported.
pub(crate) fn read_codex_declared_tier(
    session_id: SessionId,
    reply: &RawValue,
) -> Option<ProviderOutputSpeedState> {
    let tier = read_codex_object::<ServiceTierCarrier>(reply.get())?.service_tier?;
    read_tier(session_id, tier)
}

/// Arms an accepted turn's run to report the tier it settles at, answering the settlement now when
/// the turn already ended, on the tier the thread holds. A turn whose `sent_level` changes the
/// declared tier settles on the settings notice that change produces; any other on its first item.
pub(crate) fn arm_codex_run_output_speed(
    record: &mut CodexSessionRecord,
    turn_id: String,
    run_id: RunId,
    sent_level: Option<&str>,
) -> Option<CodexSettledOutputSpeed> {
    if record.is_turn_settled(&turn_id) {
        return settlement(record, run_id);
    }
    let awaits_settings_notice = sent_level.is_some_and(|sent_level| {
        record
            .declared_output_speed
            .as_ref()
            .is_none_or(|declared| declared.declared.as_str() != sent_level)
    });
    record.unsettled_output_speed_runs.insert(
        turn_id,
        CodexUnsettledOutputSpeedRun {
            run_id,
            awaits_settings_notice,
        },
    );
    None
}

/// Reads one frame of the session's own conversation into the speed report: `thread/settings/
/// updated` sets the declared tier and settles every armed run; a turn's first `item/started`
/// settles its run unless it awaits that notice; its `turn/completed` settles whatever is left. A
/// helper's frames change nothing.
pub(crate) fn observe_codex_output_speed_frame(
    record: &mut CodexSessionRecord,
    method: &str,
    params: &RawValue,
) -> Vec<CodexSettledOutputSpeed> {
    let Some(frame) = read_codex_object::<SpeedFrame>(params.get()) else {
        return Vec::new();
    };
    if frame.thread_id.as_deref() != Some(record.thread_id.as_str()) {
        return Vec::new();
    }
    match method {
        CODEX_THREAD_SETTINGS_UPDATED_METHOD => {
            let Some(tier) = frame
                .thread_settings
                .and_then(|settings| read_codex_object::<ServiceTierCarrier>(settings.get()))
                .and_then(|settings| settings.service_tier)
            else {
                return Vec::new();
            };
            record.declared_output_speed = read_tier(record.session_id, tier);
            let turn_ids: Vec<String> =
                record.unsettled_output_speed_runs.keys().cloned().collect();
            turn_ids
                .iter()
                .filter_map(|turn_id| settle_turn(record, turn_id))
                .collect()
        }
        CODEX_ITEM_STARTED_METHOD => frame
            .turn_id
            .filter(|turn_id| {
                record
                    .unsettled_output_speed_runs
                    .get(turn_id)
                    .is_some_and(|unsettled| !unsettled.awaits_settings_notice)
            })
            .and_then(|turn_id| settle_turn(record, &turn_id))
            .into_iter()
            .collect(),
        CODEX_TURN_COMPLETED_METHOD => frame
            .turn
            .and_then(|turn| turn.id)
            .and_then(|turn_id| settle_turn(record, &turn_id))
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

fn settle_turn(record: &mut CodexSessionRecord, turn_id: &str) -> Option<CodexSettledOutputSpeed> {
    let unsettled = record.unsettled_output_speed_runs.remove(turn_id)?;
    settlement(record, unsettled.run_id)
}

// Nothing is reported for a thread that never declared a tier.
fn settlement(record: &CodexSessionRecord, run_id: RunId) -> Option<CodexSettledOutputSpeed> {
    Some(CodexSettledOutputSpeed {
        session_id: record.session_id,
        run_id,
        provider_account_id: record.provider_account_id.clone(),
        state: record.declared_output_speed.clone()?,
    })
}

// A `null` tier is a thread on standard speed: a reading, never an absence.
fn read_tier(session_id: SessionId, tier: Option<Value>) -> Option<ProviderOutputSpeedState> {
    read_declared_output_speed(DeclaredOutputSpeed {
        provider: DESCRIPTOR.provider_id(),
        session_id,
        declared: tier.unwrap_or_else(|| Value::from(DESCRIPTOR.standard_output_speed)),
        reason: None,
    })
}
