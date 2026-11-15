//! A hosted web search's per-call charge: each `webSearch` item Codex's stream completes with a
//! `search` action, and each `web_search_call` line a rollout file holds with one, is one call the
//! API bills, charged as a usage row of its own with no tokens, since the export and a rollout's
//! usage record never count searches; its sighting is keyed by the item's id, which the stream and
//! the file share, so the search is charged once whichever names it first. Opening a page or
//! finding in one is no billed call.

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::event::usage::UsageSightingSource;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::event_normalizer::CODEX_ITEM_COMPLETED_METHOD;
use crate::driver::codex::telemetry::sighting::compose_codex_search_sighting;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::usage_delta_accountant::{
    MeteredUsageDelta, UsageAxisCounts, UsageRequestFacts, meter_from_zero,
};

/// The item Codex completes for each step of a hosted web search.
const CODEX_WEB_SEARCH_ITEM_TYPE: &str = "webSearch";

/// The action of the one step the API bills.
const CODEX_BILLED_SEARCH_ACTION: &str = "search";

// The members of an `item/completed` frame a search's charge reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemFrame {
    thread_id: Option<String>,
    turn_id: Option<String>,
    item: Option<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    id: Option<String>,
    action: Option<SearchAction>,
}

#[derive(Deserialize)]
struct SearchAction {
    #[serde(rename = "type")]
    action_type: Option<String>,
}

/// One billed hosted web search a completed item states: its thread, its turn and its own id.
pub(crate) struct CodexWebSearch {
    thread_id: String,
    turn_id: Option<String>,
    id: String,
}

impl CodexWebSearch {
    /// The billed search `method`'s `params` state; `None` for any other frame or item, and for
    /// a search that names no thread or id.
    pub(crate) fn read(method: &str, params: &RawValue) -> Option<Self> {
        if method != CODEX_ITEM_COMPLETED_METHOD {
            return None;
        }
        let frame = read_codex_object::<ItemFrame>(params.get())?;
        let item = frame.item?;
        let is_billed = item.item_type.as_deref() == Some(CODEX_WEB_SEARCH_ITEM_TYPE)
            && item.action.and_then(|action| action.action_type).as_deref()
                == Some(CODEX_BILLED_SEARCH_ACTION);
        if !is_billed {
            return None;
        }
        let thread_id = frame.thread_id.filter(|thread_id| !thread_id.is_empty())?;
        let Some(id) = item.id.filter(|id| !id.is_empty()) else {
            tracing::warn!(
                conversation_id = thread_id.as_str(),
                "a codex web search names no id; it is not charged"
            );
            return None;
        };
        Some(Self {
            thread_id,
            turn_id: frame.turn_id.filter(|turn_id| !turn_id.is_empty()),
            id,
        })
    }

    /// The billed search `id` a rollout file of `thread_id` states, filed on whatever turn its
    /// reader files it on.
    pub(crate) fn new(thread_id: &str, id: &str) -> Self {
        Self {
            thread_id: thread_id.to_owned(),
            turn_id: None,
            id: id.to_owned(),
        }
    }

    /// The thread the search ran on.
    pub(crate) fn thread_id(&self) -> &str {
        &self.thread_id
    }

    /// The turn the frame names, if any.
    pub(crate) fn turn_id(&self) -> Option<&str> {
        self.turn_id.as_deref()
    }

    /// The search's charge: one row of one search and no tokens on its thread and turn, priced by
    /// `request`'s model and tier, with `source`'s sighting keyed by the search's id.
    pub(crate) fn meter(
        self,
        source: UsageSightingSource,
        request: UsageRequestFacts,
    ) -> MeteredUsageDelta {
        let mut delta = meter_from_zero(
            DESCRIPTOR.provider_id(),
            self.thread_id,
            UsageAxisCounts::default(),
            UsageRequestFacts {
                web_search_requests: Some(1),
                ..request
            },
        );
        delta.attributed_turn_id = self.turn_id;
        delta.sighting = compose_codex_search_sighting(source, &self.id);
        delta
    }
}
