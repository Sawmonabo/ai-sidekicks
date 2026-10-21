//! Codex's capability declaration and its model catalog read: the flags the driver delivers,
//! narrowed by the zero-turn probe of the build the version reading describes, and the
//! `model/list` pages driven to their end into the picker's models.

use std::collections::HashSet;
use std::future::Future;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_TOKEN_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::DESCRIPTOR;
use super::capability_probe::CAPABILITY_PROBE_RULES;
use super::tools::codex_tool_metadata;
use crate::provider::capability::probe::{CapabilityProbeExchange, read_provider_capabilities};
use crate::provider::driver::capabilities::{DriverCapabilityFlag, DriverCapabilityFlags};
use crate::provider::driver::contract::{DriverError, GetCapabilitiesResult, bound_failure_detail};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::provider::driver::error_causes::ModelCatalogUnreadable;
use crate::provider::inbound_json::decode_inbound_json;
use crate::provider::record_readers::read_non_empty_string;
use crate::provider::spawned_version::SpawnedProviderVersionReading;

/// The capability contract's version, which the writer compares to see a change; it moves
/// whenever the shape of what this driver declares changes.
const CODEX_CAPABILITY_CONTRACT_VERSION: &str = "3.1.0";

/// Codex's catalog read, as its wire names the method.
const CODEX_MODEL_LIST_METHOD: &str = "model/list";

/// The most pages a catalog read takes: Codex answers its whole catalog on one page when no page
/// size is asked, so a service still sending cursors past this is faulty.
const CODEX_MODEL_CATALOG_MAX_PAGES: usize = 20;

/// The most rows, hidden ones included, a catalog read keeps across its pages.
const CODEX_MODEL_CATALOG_MAX_ROWS: usize = 1000;

/// Stands in for a catalog fault whose words are blank, which none is.
static CATALOG_FAULT_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The model catalog could not be read.".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

/// The name the catalog gives the tier that speeds output up; the tier's id is free-form.
const CODEX_FAST_TIER_NAME: &str = "Fast";

/// One catalog model text: an id, a name, a tier id or an effort.
type CatalogText = FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>;

/// Whether the driver delivers `flag` at its own boundary; a flag added to the set is a compile
/// error here until it is decided.
///
/// Each is delivered: resuming is a thread operation of its own; steering is `turn/steer`; typed
/// requests are answered mid-turn; tool servers' tools are called, though not every server's can
/// be listed; each tool call is a discrete item paired with its result; model and effort ride each
/// turn's start; a turn takes a caller's output schema; a fork at an inclusive turn boundary rolls
/// back, a build refusing the boundary failing the fork; the session moves onto a conversation
/// forked from its own; a thread keeps a goal it sets and clears; the daemon's tools reach the
/// model through the session's tool-server entry; peer agents are spawned, messaged and closed
/// within a turn; an asked compaction announces itself as an unasked one does; the skill list is
/// read and announces its changes; the service tier rides each thread and turn, which declare it
/// back, each model's tiers read from the catalog. This transport carries no reasoning tokens.
const fn is_codex_flag_declared(flag: DriverCapabilityFlag) -> bool {
    match flag {
        DriverCapabilityFlag::Resume
        | DriverCapabilityFlag::Steer
        | DriverCapabilityFlag::InteractiveRequests
        | DriverCapabilityFlag::Mcp
        | DriverCapabilityFlag::ToolCalls
        | DriverCapabilityFlag::ModelMutation
        | DriverCapabilityFlag::StructuredOutput
        | DriverCapabilityFlag::Rollback
        | DriverCapabilityFlag::SessionFork
        | DriverCapabilityFlag::SessionGoals
        | DriverCapabilityFlag::CallbackTools
        | DriverCapabilityFlag::Subagents
        | DriverCapabilityFlag::ContextCompaction
        | DriverCapabilityFlag::ProviderCommands
        | DriverCapabilityFlag::OutputSpeed => true,
        DriverCapabilityFlag::ReasoningStream => false,
    }
}

/// Reads the capabilities of the build `version` describes: probes that same build through
/// `exchange`, reports each flag the probe withdrew, and composes the driver's flags, tools and
/// the version it printed. Fails with [`DriverError::CapabilityProbe`] when the probe read fails.
pub(crate) async fn read_codex_capabilities(
    version: &SpawnedProviderVersionReading,
    exchange: &mut impl CapabilityProbeExchange,
) -> Result<GetCapabilitiesResult, DriverError> {
    read_provider_capabilities(
        &DESCRIPTOR,
        &CAPABILITY_PROBE_RULES,
        &DriverCapabilityFlags::from_fn(is_codex_flag_declared),
        CODEX_CAPABILITY_CONTRACT_VERSION,
        codex_tool_metadata(),
        version,
        exchange,
    )
    .await
}

/// One `model/list` result: its rows and the cursor of the next page, `null` on the last.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelListPage {
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    next_cursor: Option<String>,
}

// Where a row sits in the catalog, for the words of a fault or a report.
#[derive(Clone, Copy)]
struct RowPlace {
    page: usize,
    row: usize,
}

/// The `model/list` catalog read so far, page by page: the visible rows as models, every id seen,
/// hidden rows included, and every cursor a page answered, each bounded by the read's limits.
pub(crate) struct CodexModelCatalogReader {
    provider: ProviderId,
    models: Vec<ProviderModel>,
    seen_ids: HashSet<String>,
    seen_cursors: HashSet<String>,
    pages_read: usize,
}

impl Default for CodexModelCatalogReader {
    fn default() -> Self {
        Self {
            provider: DESCRIPTOR.provider_id(),
            models: Vec::new(),
            seen_ids: HashSet::new(),
            seen_cursors: HashSet::new(),
            pages_read: 0,
        }
    }
}

impl CodexModelCatalogReader {
    /// Reads one `model/list` result's JSON text and keeps its visible rows, answering the next
    /// page's cursor or `None` on the last page. Fails with [`DriverError::ModelCatalogUnreadable`]
    /// for a result with no `data` array, a row that is not an object, a row with no readable
    /// `id` or `displayName`, an id listed twice, a cursor an earlier page already answered, a row
    /// past the 1,000th or a cursor on the 20th page.
    pub(crate) fn read_page(
        &mut self,
        reply: &str,
        diagnostics: &mut OnceReportedDiagnostics,
    ) -> Result<Option<String>, DriverError> {
        let page = self.pages_read + 1;
        let text = decode_inbound_json(reply.as_bytes());
        let ModelListPage { data, next_cursor } = serde_json::from_str(&text).map_err(|error| {
            self.unreadable(&format!("page {page} is not a readable reply: {error}"))
        })?;
        let Some(Value::Array(rows)) = data else {
            return Err(self.unreadable(&format!("page {page} has no `data` array")));
        };
        for (index, row) in rows.iter().enumerate() {
            let place = RowPlace {
                page,
                row: index + 1,
            };
            self.read_row(row, place, diagnostics)?;
        }
        self.pages_read = page;
        let Some(cursor) = next_cursor else {
            return Ok(None);
        };
        if page == CODEX_MODEL_CATALOG_MAX_PAGES {
            return Err(self.past_limits(page));
        }
        // A cursor answered twice would drive the read in a circle.
        if !self.seen_cursors.insert(cursor.clone()) {
            return Err(self.unreadable(&format!(
                "page {page} answers the cursor {cursor:?}, which an earlier page already answered"
            )));
        }
        Ok(Some(cursor))
    }

    /// The models of every page read, in the catalog's order.
    pub(crate) fn into_models(self) -> Vec<ProviderModel> {
        self.models
    }

    // Reads one row: a hidden one is only counted against duplicates; a visible one becomes a
    // model, its optional members read as absent where they cannot be read.
    fn read_row(
        &mut self,
        row: &Value,
        place: RowPlace,
        diagnostics: &mut OnceReportedDiagnostics,
    ) -> Result<(), DriverError> {
        let RowPlace { page, row: index } = place;
        let Some(row) = row.as_object() else {
            return Err(self.unreadable(&format!("row {index} of page {page} is not an object")));
        };
        if self.seen_ids.len() == CODEX_MODEL_CATALOG_MAX_ROWS {
            return Err(self.past_limits(page));
        }
        let Some(id) = read_catalog_text(row, "id") else {
            return Err(
                self.unreadable(&format!("row {index} of page {page} has no readable `id`"))
            );
        };
        // The catalog has no alias, so an id listed twice is a malformed reply.
        if !self.seen_ids.insert(id.as_str().to_owned()) {
            return Err(self.unreadable(&format!(
                "row {index} of page {page} lists the model {:?} a second time",
                id.as_str()
            )));
        }
        if row.get("hidden") == Some(&Value::Bool(true)) {
            return Ok(());
        }
        let Some(name) = read_catalog_text(row, "displayName") else {
            return Err(self.unreadable(&format!(
                "row {index} of page {page}, the model {:?}, has no readable `displayName`",
                id.as_str()
            )));
        };
        let (tier_ids, fast) = self.read_service_tiers(row, &id, place, diagnostics);
        // Absent, not empty, when the model publishes no tier: it has no speed selection. The
        // standard level leads so a person can ask for it back, never doubled.
        let output_speed_levels = (!tier_ids.is_empty()).then(|| {
            let standard = CatalogText::new(DESCRIPTOR.standard_output_speed.to_owned())
                .expect("the standard output speed is non-blank and within the cap");
            std::iter::once(standard.clone())
                .chain(tier_ids.into_iter().filter(|tier_id| *tier_id != standard))
                .collect()
        });
        let effort_levels = self.read_effort_levels(row, &id, place, diagnostics);
        self.models.push(ProviderModel {
            id,
            name,
            capabilities: Vec::new(),
            effort_levels,
            output_speed_levels,
            // A tier list alone is not fast output: a model could list only a slower tier.
            fast,
            // A larger window is read from the catalog dump, which adds its own row for it.
            larger_window: false,
            context_window: None,
        });
        Ok(())
    }

    // The row's tier ids, each `{ id, name, description }`, and whether one is the fast tier. An
    // unreadable list reads as no tiers and an unreadable tier is left out, each reported.
    fn read_service_tiers(
        &self,
        row: &Map<String, Value>,
        id: &CatalogText,
        place: RowPlace,
        diagnostics: &mut OnceReportedDiagnostics,
    ) -> (Vec<CatalogText>, bool) {
        let mut tier_ids = Vec::new();
        let mut fast = false;
        let tiers = match row.get("serviceTiers") {
            None | Some(Value::Null) => return (tier_ids, fast),
            Some(Value::Array(tiers)) => tiers,
            Some(_) => {
                self.report_unreadable_member(diagnostics, "serviceTiers", id, place);
                return (tier_ids, fast);
            }
        };
        for tier in tiers {
            let readable = tier
                .as_object()
                .and_then(|tier| read_catalog_text(tier, "id").map(|tier_id| (tier, tier_id)));
            let Some((tier, tier_id)) = readable else {
                self.report_unreadable_member(diagnostics, "serviceTiers[]", id, place);
                continue;
            };
            fast |= tier.get("name").and_then(Value::as_str) == Some(CODEX_FAST_TIER_NAME);
            tier_ids.push(tier_id);
        }
        (tier_ids, fast)
    }

    // The row's reasoning efforts, each `{ reasoningEffort, description }`, kept as the open words
    // the model publishes. An unreadable list or no readable effort reads as absent, and an
    // unreadable effort is left out, each reported.
    fn read_effort_levels(
        &self,
        row: &Map<String, Value>,
        id: &CatalogText,
        place: RowPlace,
        diagnostics: &mut OnceReportedDiagnostics,
    ) -> Option<Vec<CatalogText>> {
        let efforts = match row.get("supportedReasoningEfforts") {
            None | Some(Value::Null) => return None,
            Some(Value::Array(efforts)) => efforts,
            Some(_) => {
                self.report_unreadable_member(diagnostics, "supportedReasoningEfforts", id, place);
                return None;
            }
        };
        let mut levels = Vec::with_capacity(efforts.len());
        for effort in efforts {
            match effort
                .as_object()
                .and_then(|effort| read_catalog_text(effort, "reasoningEffort"))
            {
                Some(level) => levels.push(level),
                None => self.report_unreadable_member(
                    diagnostics,
                    "supportedReasoningEfforts[]",
                    id,
                    place,
                ),
            }
        }
        (!levels.is_empty()).then_some(levels)
    }

    // Reports, once per member on this connection, a row member read as absent.
    fn report_unreadable_member(
        &self,
        diagnostics: &mut OnceReportedDiagnostics,
        member: &str,
        id: &CatalogText,
        place: RowPlace,
    ) {
        diagnostics.report(&DriverDiagnosticRecord {
            provider: self.provider.clone(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::ModelCatalogMemberUnreadable,
            raw_wire_type: Some(format!("{CODEX_MODEL_LIST_METHOD}:{member}")),
            disposition_reason: format!(
                "the catalog row's `{member}` could not be read, so the model reads it as absent; \
                 the row and the rest of the catalog stand"
            ),
            details: Map::from_iter([
                ("modelId".to_owned(), Value::from(id.as_str())),
                ("page".to_owned(), Value::from(place.page)),
                ("row".to_owned(), Value::from(place.row)),
            ]),
        });
    }

    // The fault of a catalog that runs past the pages or rows a read takes, naming the pages
    // reached and the rows read.
    fn past_limits(&self, pages: usize) -> DriverError {
        self.unreadable(&format!(
            "the catalog runs past {CODEX_MODEL_CATALOG_MAX_PAGES} pages or \
             {CODEX_MODEL_CATALOG_MAX_ROWS} rows: {pages} pages and {} rows read",
            self.seen_ids.len()
        ))
    }

    // The whole catalog's fault, naming the row, the cursor or the counts in `detail`, which is
    // bounded, since a cursor or an id is the service's own text.
    fn unreadable(&self, detail: &str) -> DriverError {
        DriverError::ModelCatalogUnreadable(ModelCatalogUnreadable {
            provider: self.provider.clone(),
            reply_name: CODEX_MODEL_LIST_METHOD,
            detail: bound_failure_detail(detail, CATALOG_FAULT_FALLBACK.clone()),
        })
    }
}

// The non-empty string at `key` that a catalog text holds; `None` for anything else.
fn read_catalog_text(source: &Map<String, Value>, key: &str) -> Option<CatalogText> {
    read_non_empty_string(source, key).and_then(|text| CatalogText::new(text.to_owned()).ok())
}

/// Reads Codex's whole model catalog, asking `request_page` for each `model/list` result's JSON,
/// first with no cursor and then with each cursor a page answers, until a page answers none.
/// Fails with the first page request's failure, or as [`CodexModelCatalogReader::read_page`]
/// fails, at most 20 pages in; never answers a short catalog.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex driver's model list answers through it over the service connection"
    )
)]
pub(crate) async fn read_codex_model_catalog<Page, PageReply>(
    mut request_page: Page,
    diagnostics: &mut OnceReportedDiagnostics,
) -> Result<Vec<ProviderModel>, DriverError>
where
    Page: FnMut(Option<String>) -> PageReply,
    PageReply: Future<Output = Result<Box<RawValue>, DriverError>>,
{
    let mut reader = CodexModelCatalogReader::default();
    let mut cursor = None;
    loop {
        let reply = request_page(cursor).await?;
        cursor = reader.read_page(reply.get(), diagnostics)?;
        if cursor.is_none() {
            return Ok(reader.into_models());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use serde_json::json;
    use serde_json::value::RawValue;

    use super::read_codex_model_catalog;
    use crate::provider::driver::contract::DriverError;
    use crate::provider::driver::diagnostics::OnceReportedDiagnostics;

    // Answers each scripted page in turn, recording the cursor each was asked with; a request
    // past the script panics, so a read that does not stop fails rather than loops.
    async fn read_pages(
        pages: Vec<serde_json::Value>,
    ) -> (Result<Vec<String>, DriverError>, Vec<Option<String>>) {
        let mut pages = VecDeque::from(pages);
        let mut cursors = Vec::new();
        let mut diagnostics = OnceReportedDiagnostics::default();
        let result = read_codex_model_catalog(
            |cursor| {
                cursors.push(cursor);
                let page = pages.pop_front();
                async move {
                    let page = page.expect("the read asked for a page past the script");
                    Ok::<_, DriverError>(
                        RawValue::from_string(page.to_string()).expect("the page is JSON"),
                    )
                }
            },
            &mut diagnostics,
        )
        .await;
        let ids = result.map(|models| {
            models
                .into_iter()
                .map(|model| model.id.into_string())
                .collect()
        });
        (ids, cursors)
    }

    fn row(id: &str) -> serde_json::Value {
        json!({ "id": id, "displayName": id.to_uppercase(), "hidden": false })
    }

    #[tokio::test]
    async fn the_read_drives_every_page_to_the_last() {
        let (ids, cursors) = read_pages(vec![
            json!({ "data": [row("gpt-a"), row("gpt-b")], "nextCursor": "after-b" }),
            json!({ "data": [row("gpt-c")], "nextCursor": null }),
        ])
        .await;

        assert_eq!(ids.expect("the catalog reads"), ["gpt-a", "gpt-b", "gpt-c"]);
        assert_eq!(cursors, [None, Some("after-b".to_owned())]);
    }

    #[tokio::test]
    async fn a_cursor_answered_twice_stops_the_read_with_the_catalog_fault() {
        let (ids, cursors) = read_pages(vec![
            json!({ "data": [row("gpt-a")], "nextCursor": "again" }),
            json!({ "data": [row("gpt-b")], "nextCursor": "again" }),
            json!({ "data": [], "nextCursor": null }),
        ])
        .await;

        let Err(DriverError::ModelCatalogUnreadable(unreadable)) = ids else {
            panic!("a repeated cursor must fail the catalog, not answer it: {ids:?}");
        };
        assert!(
            unreadable.detail.as_str().contains("\"again\""),
            "{}",
            unreadable.detail.as_str()
        );
        assert_eq!(cursors.len(), 2);
    }

    #[tokio::test]
    async fn an_id_listed_on_two_pages_fails_the_catalog() {
        let (ids, _) = read_pages(vec![
            json!({ "data": [row("gpt-a")], "nextCursor": "next" }),
            json!({ "data": [row("gpt-b"), row("gpt-a")], "nextCursor": null }),
        ])
        .await;

        let Err(DriverError::ModelCatalogUnreadable(unreadable)) = ids else {
            panic!("a duplicate id must fail the catalog, not answer it: {ids:?}");
        };
        assert!(
            unreadable.detail.as_str().contains("row 2 of page 2"),
            "{}",
            unreadable.detail.as_str()
        );
    }

    // A service that answers a fresh cursor for ever, its pages holding `rows_per_page` rows each.
    async fn read_endless_pages(rows_per_page: usize) -> (String, usize) {
        let mut pages_asked = 0;
        let mut diagnostics = OnceReportedDiagnostics::default();
        let result = read_codex_model_catalog(
            |_| {
                pages_asked += 1;
                let rows: Vec<_> = (0..rows_per_page)
                    .map(|row_index| row(&format!("gpt-{pages_asked}-{row_index}")))
                    .collect();
                let page = json!({ "data": rows, "nextCursor": format!("after-{pages_asked}") });
                async move {
                    Ok::<_, DriverError>(
                        RawValue::from_string(page.to_string()).expect("the page is JSON"),
                    )
                }
            },
            &mut diagnostics,
        )
        .await;
        let Err(DriverError::ModelCatalogUnreadable(unreadable)) = result else {
            panic!("a catalog without end must fail, not answer: {result:?}");
        };
        (unreadable.detail.into_string(), pages_asked)
    }

    #[tokio::test]
    async fn a_catalog_past_twenty_pages_or_a_thousand_rows_fails_naming_its_counts() {
        let (detail, pages_asked) = read_endless_pages(1).await;
        assert_eq!(pages_asked, 20);
        assert!(detail.ends_with("20 pages and 20 rows read"), "{detail}");

        let (detail, pages_asked) = read_endless_pages(400).await;
        assert_eq!(pages_asked, 3);
        assert!(detail.ends_with("3 pages and 1000 rows read"), "{detail}");
    }
}
