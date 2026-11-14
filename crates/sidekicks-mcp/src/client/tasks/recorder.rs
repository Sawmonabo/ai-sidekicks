//! The task handle recorder: the one writer of `command_receipts.mcp_task_id`, the handle an MCP
//! task-augmented call's acceptance names, which recovery polls instead of running the call
//! again, and of the task's generation, server name and endpoint, which say how and where to poll
//! it and are written in the same statement.
//!
//! - A handle past the column's bound is refused, never cut, since a cut handle names another
//!   task; a refusal leaves the columns `NULL`, so a restart never runs the call again, and its
//!   run goes on, told the outcome is unknown.
//! - The first handle wins: the claim writes only `NULL` columns, and the read-back in the same
//!   write tells an absent receipt, the same task already stored, and a different one apart.

use std::borrow::Cow;
use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::types::Value as SqlValue;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use strum::IntoStaticStr;

use crate::client::tasks::{McpTaskHandleObservation, McpTaskHandleSink};

/// The longest stored task handle, in code points as SQLite's `length()` counts them: the bound
/// the column's check holds, repeated so a refusal names the server, tool and length instead of
/// an opaque constraint failure.
pub(crate) const MCP_TASK_ID_MAX_LENGTH: usize = 256;

/// Claims the receipt's four task columns together, only while the handle is still `NULL`, since
/// the table's check holds all four set or all four `NULL`.
const CLAIM_HANDLE_SQL: &str = "UPDATE command_receipts \
                                SET mcp_task_id = @mcp_task_id, \
                                    mcp_task_generation = @mcp_task_generation, \
                                    mcp_server_name = @mcp_server_name, \
                                    mcp_server_endpoint = @mcp_server_endpoint \
                                WHERE command_id = @command_id AND mcp_task_id IS NULL";

/// Reads the receipt's four task columns back, in the same write as the claim.
const READ_STORED_HANDLE_SQL: &str = "SELECT mcp_task_id, mcp_task_generation, mcp_server_name, \
                                             mcp_server_endpoint \
                                      FROM command_receipts WHERE command_id = @command_id";

/// Why a handle was not stored. The column's check refuses `HandleEmpty`, `HandleTooLong` and
/// `HandleContainsNul`; it cannot see `HandleNotWellFormed`; `ReceiptAbsent` and `HandleConflict`
/// are states of the receipt row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum McpTaskHandleRefusalReason {
    /// The handle is empty.
    HandleEmpty,
    /// The handle is longer than [`MCP_TASK_ID_MAX_LENGTH`].
    HandleTooLong,
    /// The handle holds U+0000.
    HandleContainsNul,
    /// The handle holds U+FFFD, which the inbound decode writes for a lone surrogate, so it names
    /// a task the server never issued.
    HandleNotWellFormed,
    /// No receipt row carries the dispatch's command id.
    ReceiptAbsent,
    /// The receipt already holds a different task: another handle, generation, server name or
    /// endpoint.
    HandleConflict,
}

/// What offering one handle to its receipt row came to; `AlreadyRecorded` is a success.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpTaskHandleRecordOutcome {
    /// The handle is stored.
    Recorded,
    /// The receipt already held this same handle, generation, server name and endpoint.
    AlreadyRecorded,
    /// The handle was not stored, for `reason`; the columns are unchanged.
    Refused {
        /// Why.
        reason: McpTaskHandleRefusalReason,
    },
    /// The database failed the write; the columns are unchanged.
    StorageFailed,
}

/// One bounded walk over a handle: it stops at the first code point past the bound, or within the
/// bound at the first U+0000 or U+FFFD, so an untrusted handle of any size costs at most one code
/// point more than the bound.
struct HandleScan {
    /// Code points walked: the exact length for a clean handle, else where the walk stopped.
    scanned_code_points: usize,
    /// Why the handle cannot be stored, or `None` when it can.
    refusal: Option<McpTaskHandleRefusalReason>,
}

impl HandleScan {
    fn of(handle: &str) -> Self {
        let mut scanned_code_points = 0;
        for character in handle.chars().take(MCP_TASK_ID_MAX_LENGTH + 1) {
            scanned_code_points += 1;
            let refusal = if scanned_code_points > MCP_TASK_ID_MAX_LENGTH {
                Some(McpTaskHandleRefusalReason::HandleTooLong)
            } else if character == '\0' {
                Some(McpTaskHandleRefusalReason::HandleContainsNul)
            } else if character == char::REPLACEMENT_CHARACTER {
                Some(McpTaskHandleRefusalReason::HandleNotWellFormed)
            } else {
                None
            };
            if refusal.is_some() {
                return Self {
                    scanned_code_points,
                    refusal,
                };
            }
        }
        Self {
            scanned_code_points,
            refusal: (scanned_code_points == 0).then_some(McpTaskHandleRefusalReason::HandleEmpty),
        }
    }
}

/// Stores each observed task handle on its dispatch's command receipt row. It never fails the
/// turn: every failure is an outcome and a service-log warning, and leaves the columns `NULL`.
pub(crate) struct McpTaskHandleRecorder {
    writer: Arc<DatabaseWriter>,
}

impl McpTaskHandleRecorder {
    /// A recorder writing through `writer`.
    pub(crate) fn new(writer: Arc<DatabaseWriter>) -> Self {
        Self { writer }
    }

    /// Offers `observation`'s handle to its receipt row. Every refusal and storage failure is
    /// logged and returned, never raised, and leaves the columns as they were.
    pub(crate) async fn store(
        &self,
        observation: &McpTaskHandleObservation,
    ) -> McpTaskHandleRecordOutcome {
        let handle = observation.mcp_task_id.as_str();
        let scan = HandleScan::of(handle);
        if let Some(reason) = scan.refusal {
            return refuse(observation, reason, scan.scanned_code_points);
        }
        let command_id = &observation.dispatch.command_id;
        let generation = <&str>::from(observation.mcp_task_generation);
        let server_name = observation.server_name.as_str();
        let endpoint = observation.endpoint.as_str();
        let statement = |sql: &'static str, bindings| WriteStatement {
            sql: Cow::Borrowed(sql),
            bindings: StatementBindings::Named(bindings),
            expected_row_count: None,
        };
        let write = self
            .writer
            .write(vec![
                statement(
                    CLAIM_HANDLE_SQL,
                    vec![
                        text_binding("@mcp_task_id", handle),
                        text_binding("@mcp_task_generation", generation),
                        text_binding("@mcp_server_name", server_name),
                        text_binding("@mcp_server_endpoint", endpoint),
                        text_binding("@command_id", command_id),
                    ],
                ),
                statement(
                    READ_STORED_HANDLE_SQL,
                    vec![text_binding("@command_id", command_id)],
                ),
            ])
            .await;
        let results = match write {
            Ok(results) => results,
            Err(error) => return report_storage_failure(observation, &error),
        };
        let [claim, stored] = <[_; 2]>::try_from(results)
            .expect("the writer answers one result per statement it was given");
        if claim.row_count > 0 {
            return McpTaskHandleRecordOutcome::Recorded;
        }
        // Nothing changed: the receipt is absent or holds a task; the read-back says which.
        let reason = match stored.rows.first().map(Vec::as_slice) {
            None => McpTaskHandleRefusalReason::ReceiptAbsent,
            Some(
                [
                    SqlValue::Text(stored_handle),
                    SqlValue::Text(stored_generation),
                    SqlValue::Text(stored_server_name),
                    SqlValue::Text(stored_endpoint),
                ],
            ) if stored_handle == handle
                && stored_generation == generation
                && stored_server_name == server_name
                && stored_endpoint == endpoint =>
            {
                return McpTaskHandleRecordOutcome::AlreadyRecorded;
            }
            Some(_) => McpTaskHandleRefusalReason::HandleConflict,
        };
        refuse(observation, reason, scan.scanned_code_points)
    }
}

/// Logs a refused handle by its length alone, never the handle, which is untrusted output of any
/// size.
fn refuse(
    observation: &McpTaskHandleObservation,
    reason: McpTaskHandleRefusalReason,
    handle_code_points_scanned: usize,
) -> McpTaskHandleRecordOutcome {
    tracing::warn!(
        command_id = observation.dispatch.command_id.as_str(),
        server = observation.server_name.as_str(),
        tool = observation.dispatch.tool_name.as_str(),
        reason = <&str>::from(reason),
        handle_code_points_scanned,
        "a tool server's task handle was not stored on its command receipt"
    );
    McpTaskHandleRecordOutcome::Refused { reason }
}

/// Logs a write the database failed, a local fault kept apart from the peer's bad handle, with the
/// error's chain, whose SQLite words carry no SQL.
fn report_storage_failure(
    observation: &McpTaskHandleObservation,
    error: &WriteError,
) -> McpTaskHandleRecordOutcome {
    tracing::warn!(
        command_id = observation.dispatch.command_id.as_str(),
        server = observation.server_name.as_str(),
        tool = observation.dispatch.tool_name.as_str(),
        error = error as &(dyn Error + 'static),
        "the database failed to store a tool server's task handle"
    );
    McpTaskHandleRecordOutcome::StorageFailed
}

impl McpTaskHandleSink for McpTaskHandleRecorder {
    fn record(&self, observation: McpTaskHandleObservation) -> BoxFuture<'_, ()> {
        // The outcome is already logged; the sink's caller only waits for it to settle.
        async move {
            self.store(&observation).await;
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::OptionalExtension as _;
    use serde_json::Value;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_provider::driver::diagnostics::RecordedEvents;
    use sidekicks_provider::inbound_json::decode_inbound_json;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{McpTaskHandleRecordOutcome, McpTaskHandleRecorder, McpTaskHandleRefusalReason};
    use crate::client::tasks::{
        McpServerEndpoint, McpTaskDispatchIdentity, McpTaskGeneration, McpTaskHandleObservation,
        extract_mcp_task_id,
    };
    use crate::schema::schema_parts;
    use crate::sign_in::address_digest::ServerAddressKey;

    /// The four task columns of `command-1`'s receipt, `None` each while unset.
    type StoredTask = [Option<String>; 4];

    /// A writer over a fresh database holding one claimed receipt, `command-1`, with no task.
    async fn claimed_receipt() -> (TestDatabase, Arc<DatabaseWriter>) {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        database
            .reader()
            .execute(
                "INSERT INTO command_receipts \
                 (id, command_id, run_id, status, started_at, created_at) \
                 VALUES ('receipt-1', 'command-1', 'run-1', 'accepted', 't', 't')",
                [],
            )
            .expect("the claimed receipt is seeded");
        (database, Arc::new(writer))
    }

    fn stored_task(database: &TestDatabase) -> StoredTask {
        database
            .reader()
            .query_row(
                "SELECT mcp_task_id, mcp_task_generation, mcp_server_name, mcp_server_endpoint \
                 FROM command_receipts WHERE command_id = 'command-1'",
                [],
                |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?]),
            )
            .optional()
            .expect("the receipt reads")
            .expect("the receipt is there")
    }

    /// `handle` on `command-1`, a 2025-11-25 task of the `tracker` server at the docs address.
    fn offer(handle: &str) -> McpTaskHandleObservation {
        McpTaskHandleObservation {
            dispatch: McpTaskDispatchIdentity {
                command_id: "command-1".to_owned(),
                tool_name: "track".to_owned(),
            },
            mcp_task_id: handle.to_owned(),
            mcp_task_generation: McpTaskGeneration::V1,
            server_name: FreeFormText::new("tracker".to_owned()).expect("a short server name"),
            endpoint: at("https://docs.example.com/mcp"),
        }
    }

    fn at(address: &str) -> McpServerEndpoint {
        McpServerEndpoint::at_address(
            &ServerAddressKey::of_test_fill(1)
                .digest(&McpServerAddress::new(address).expect("a web address")),
        )
    }

    fn stored_of(observation: &McpTaskHandleObservation) -> StoredTask {
        [
            Some(observation.mcp_task_id.clone()),
            Some(<&str>::from(observation.mcp_task_generation).to_owned()),
            Some(observation.server_name.as_str().to_owned()),
            Some(observation.endpoint.as_str().to_owned()),
        ]
    }

    /// The `taskId` of an acceptance line as the inbound decode repairs it.
    fn decoded_handle(line: &[u8]) -> String {
        let reply: Value =
            serde_json::from_str(&decode_inbound_json(line)).expect("the repaired line parses");
        extract_mcp_task_id(reply.as_object().expect("an object"))
            .expect("the line names a task")
            .to_owned()
    }

    fn refused(reason: McpTaskHandleRefusalReason) -> McpTaskHandleRecordOutcome {
        McpTaskHandleRecordOutcome::Refused { reason }
    }

    const RECORDED: McpTaskHandleRecordOutcome = McpTaskHandleRecordOutcome::Recorded;
    const ALREADY_RECORDED: McpTaskHandleRecordOutcome =
        McpTaskHandleRecordOutcome::AlreadyRecorded;

    // Mutations: count the bound off by one, or in bytes; check U+0000 before the 257th code
    // point; drop the U+FFFD stop, or apply either stop past 256; leave out the claim's
    // `AND mcp_task_id IS NULL`; leave any one column out of the read-back's comparison; log the
    // handle; hash the address as typed instead of its canonical form; encode the digest in
    // uppercase hex, or without its prefix, which the column's check refuses.
    #[rstest]
    #[case::code_points_at_the_bound(vec![(offer(&"é".repeat(256)), RECORDED)], Some(0))]
    #[case::one_past_the_bound(
        vec![(offer(&"a".repeat(257)), refused(McpTaskHandleRefusalReason::HandleTooLong))],
        None
    )]
    #[case::nul_past_the_bound(
        vec![(
            offer(&format!("{}\0", "a".repeat(256))),
            refused(McpTaskHandleRefusalReason::HandleTooLong),
        )],
        None
    )]
    #[case::replacement_past_the_bound(
        vec![(
            offer(&format!("{}\u{FFFD}", "a".repeat(256))),
            refused(McpTaskHandleRefusalReason::HandleTooLong),
        )],
        None
    )]
    #[case::nul_first(
        vec![(
            offer("kq7-task\0\u{FFFD}x"),
            refused(McpTaskHandleRefusalReason::HandleContainsNul),
        )],
        None
    )]
    #[case::replacement_first(
        vec![(
            offer("kq7-task\u{FFFD}\0x"),
            refused(McpTaskHandleRefusalReason::HandleNotWellFormed),
        )],
        None
    )]
    #[case::a_lone_surrogate_escape(
        vec![(
            offer(&decoded_handle(br#"{"task":{"taskId":"kq7-task-\ud800"}}"#)),
            refused(McpTaskHandleRefusalReason::HandleNotWellFormed),
        )],
        None
    )]
    #[case::an_encoded_lone_surrogate(
        vec![(
            offer(&decoded_handle(b"{\"task\":{\"taskId\":\"kq7-task-\xED\xA0\x80\"}}")),
            refused(McpTaskHandleRefusalReason::HandleNotWellFormed),
        )],
        None
    )]
    #[case::empty(vec![(offer(""), refused(McpTaskHandleRefusalReason::HandleEmpty))], None)]
    #[case::no_receipt(
        vec![(
            McpTaskHandleObservation {
                dispatch: McpTaskDispatchIdentity {
                    command_id: "command-2".to_owned(),
                    ..offer("kq7-task-1").dispatch
                },
                ..offer("kq7-task-1")
            },
            refused(McpTaskHandleRefusalReason::ReceiptAbsent),
        )],
        None
    )]
    #[case::the_same_task_twice(
        vec![(offer("kq7-task-1"), RECORDED), (offer("kq7-task-1"), ALREADY_RECORDED)],
        Some(0)
    )]
    #[case::another_generation(
        vec![
            (offer("kq7-task-1"), RECORDED),
            (
                McpTaskHandleObservation {
                    mcp_task_generation: McpTaskGeneration::V2,
                    ..offer("kq7-task-1")
                },
                refused(McpTaskHandleRefusalReason::HandleConflict),
            ),
        ],
        Some(0)
    )]
    #[case::another_server_name(
        vec![
            (offer("kq7-task-1"), RECORDED),
            (
                McpTaskHandleObservation {
                    server_name: FreeFormText::new("other".to_owned()).expect("a server name"),
                    ..offer("kq7-task-1")
                },
                refused(McpTaskHandleRefusalReason::HandleConflict),
            ),
        ],
        Some(0)
    )]
    #[case::another_endpoint(
        vec![
            (offer("kq7-task-1"), RECORDED),
            (
                McpTaskHandleObservation {
                    endpoint: McpServerEndpoint::stdio(),
                    ..offer("kq7-task-1")
                },
                refused(McpTaskHandleRefusalReason::HandleConflict),
            ),
        ],
        Some(0)
    )]
    #[case::another_handle(
        vec![
            (offer("kq7-task-1"), RECORDED),
            (offer("kq7-task-2"), refused(McpTaskHandleRefusalReason::HandleConflict)),
        ],
        Some(0)
    )]
    #[case::one_server_spelled_two_ways(
        vec![
            (
                McpTaskHandleObservation {
                    endpoint: at("HTTPS://Docs.Example.com/mcp"),
                    ..offer("kq7-task-1")
                },
                RECORDED,
            ),
            (offer("kq7-task-1"), ALREADY_RECORDED),
        ],
        Some(0)
    )]
    #[tokio::test]
    async fn a_task_is_stored_once_whole_and_a_handle_it_cannot_name_is_refused(
        #[case] offers: Vec<(McpTaskHandleObservation, McpTaskHandleRecordOutcome)>,
        #[case] kept_offer: Option<usize>,
    ) {
        let (database, writer) = claimed_receipt().await;
        let recorder = McpTaskHandleRecorder::new(writer);
        let recorded = RecordedEvents::default();
        let _recording = recorded.record_until_dropped();

        for (observation, expected) in &offers {
            assert_eq!(recorder.store(observation).await, *expected);
        }

        let stored = stored_task(&database);
        let expected_stored = kept_offer.map_or([None, None, None, None], |index| {
            stored_of(&offers[index].0)
        });
        assert_eq!(stored, expected_stored);
        if let Some(endpoint) = &stored[3] {
            let digest = endpoint
                .strip_prefix(McpServerEndpoint::ADDRESS_PREFIX)
                .expect("an address endpoint");
            assert_eq!(digest.len(), McpServerEndpoint::ADDRESS_DIGEST_HEX_LEN);
            assert!(
                digest
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            );
        }
        let texts = recorded.texts();
        for (observation, _) in offers
            .iter()
            .filter(|(observation, _)| !observation.mcp_task_id.is_empty())
        {
            assert!(
                texts
                    .iter()
                    .all(|text| !text.contains(&observation.mcp_task_id)),
                "no log line holds the handle"
            );
        }
    }

    // Mutation: read a failed write as `Recorded`, or log the handle with the failure.
    #[tokio::test]
    async fn a_write_the_database_fails_is_reported_without_the_handle() {
        let (database, writer) = claimed_receipt().await;
        assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
        let recorder = McpTaskHandleRecorder::new(writer);
        let recorded = RecordedEvents::default();
        let _recording = recorded.record_until_dropped();

        let outcome = recorder.store(&offer("kq7-task-1")).await;

        assert_eq!(outcome, McpTaskHandleRecordOutcome::StorageFailed);
        assert_eq!(stored_task(&database), [None, None, None, None]);
        let failures = recorded
            .messages()
            .into_iter()
            .filter(|message| message == "the database failed to store a tool server's task handle")
            .count();
        assert_eq!(failures, 1, "one warning reports the failure");
        assert!(
            recorded
                .texts()
                .iter()
                .all(|text| !text.contains("kq7-task-1")),
            "no log line holds the handle"
        );
    }
}
