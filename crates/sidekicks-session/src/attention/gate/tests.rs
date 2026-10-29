use std::error::Error;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::params;
use sidekicks_contracts::attention::{AttentionBannerState, AttentionTrigger};
use sidekicks_contracts::machine::settings::{MachineSettings, NotificationSettings};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_workspace::machine_settings::MachineSettingsReader;

use super::{DeliveryDecision, decide, read_notification_settings, write_decisions};
use crate::attention::changes::{AttentionChanges, attention_changes_after_commits};
use crate::attention::schema::schema_parts;

const MUTED_AT: &str = "2026-10-28T12:00:00.000Z";

/// A fresh database with the attention tables, its writer raising the change counts after each
/// commit, and those counts.
struct Harness {
    database: TestDatabase,
    writer: DatabaseWriter,
    changes: AttentionChanges,
}

impl Harness {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let (after_commit, changes) = attention_changes_after_commits();
        let writer = DatabaseWriter::open(
            database.opener(),
            DatabaseWriterOptions {
                after_commits: vec![after_commit],
                ..DatabaseWriterOptions::default()
            },
        )
        .await
        .expect("the writer opens its database");
        Self {
            database,
            writer,
            changes,
        }
    }

    /// An open entry `id` of `session_id` raised by `trigger`.
    fn insert_entry(&self, id: &str, session_id: SessionId, trigger: AttentionTrigger) {
        let severity = match trigger {
            AttentionTrigger::PendingApproval | AttentionTrigger::PendingInput => "actionable",
            AttentionTrigger::RunCompleted
            | AttentionTrigger::RunFailed
            | AttentionTrigger::WorkflowNotify
            | AttentionTrigger::ProviderBuild => "informational",
        };
        self.database
            .reader()
            .execute(
                "INSERT INTO attention_entries
                   (id, moment_id, session_id, trigger, severity, source_event_id, created_at)
                 VALUES (?1, ?1, ?2, ?3, ?4, ?1, '2026-10-28T12:00:01.000Z')",
                params![
                    id,
                    session_id.to_string(),
                    <&'static str>::from(trigger),
                    severity
                ],
            )
            .expect("the test entry is inserted");
    }

    /// Each entry's stored banner state and web-address state, `None` where it has no row.
    fn delivery_of(&self, entry_id: &str) -> (Option<String>, Option<String>) {
        self.database
            .reader()
            .query_row(
                "SELECT banner_state, web_address_state FROM attention_deliveries
                  WHERE entry_id = ?1",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the entry's delivery row is written")
    }

    fn entry_count(&self) -> i64 {
        self.database
            .reader()
            .query_row("SELECT count(*) FROM attention_entries", [], |row| {
                row.get(0)
            })
            .expect("the entries are counted")
    }
}

fn decided(
    entry_id: &str,
    session_id: SessionId,
    settings: Option<&NotificationSettings>,
    trigger: AttentionTrigger,
    muted_at: Option<&str>,
) -> DeliveryDecision {
    DeliveryDecision {
        entry_id: entry_id.to_owned(),
        session_id,
        decision: decide(settings, trigger, muted_at.is_some(), false, false),
        merged_into: None,
        muted_at: muted_at.map(str::to_owned),
    }
}

// A muted session's Waiting is still pending and its Finished withheld; a kind switched off
// withholds its banner while the entry stays listed and its session's count still moves. Killed by
// the mute withholding a Waiting, and by a switch that hides the entry or skips its count.
#[tokio::test]
async fn a_mute_withholds_only_ends_and_a_switch_withholds_without_hiding() {
    let harness = Harness::new().await;
    let muted = test_session_id();
    let switched_off = test_session_id();
    let mut settings = MachineSettings::default().notifications;
    settings.kinds.failed = false;
    harness.insert_entry("waiting", muted, AttentionTrigger::PendingApproval);
    harness.insert_entry("finished", muted, AttentionTrigger::RunCompleted);
    harness.insert_entry("failed", switched_off, AttentionTrigger::RunFailed);
    let switched_off_count = harness.changes.follow(Some(switched_off));

    write_decisions(
        &harness.writer,
        &[
            decided(
                "waiting",
                muted,
                Some(&settings),
                AttentionTrigger::PendingApproval,
                Some(MUTED_AT),
            ),
            decided(
                "finished",
                muted,
                Some(&settings),
                AttentionTrigger::RunCompleted,
                Some(MUTED_AT),
            ),
            decided(
                "failed",
                switched_off,
                Some(&settings),
                AttentionTrigger::RunFailed,
                None,
            ),
        ],
    )
    .await
    .expect("the decisions are written");

    let pending = Some(<&'static str>::from(AttentionBannerState::Pending).to_owned());
    let withheld = Some(<&'static str>::from(AttentionBannerState::Withheld).to_owned());
    assert_eq!(
        harness.delivery_of("waiting").0,
        pending,
        "a mute never withholds a wait"
    );
    assert_eq!(
        harness.delivery_of("finished").0,
        withheld,
        "a mute withholds an end"
    );
    assert_eq!(
        harness.delivery_of("failed").0,
        withheld,
        "a kind switched off withholds"
    );
    assert_eq!(harness.entry_count(), 3, "every entry stays listed");
    assert!(
        switched_off_count.has_changed().expect("the count is open"),
        "a withheld entry still moves its session's count"
    );
}

// The settings file cannot be read: the gate withholds every channel rather than deciding by the
// defaults. Killed by failing open to the defaults.
#[tokio::test]
async fn a_failed_settings_read_withholds_every_channel() {
    struct Unreadable;

    impl MachineSettingsReader for Unreadable {
        fn read_machine_settings(
            &self,
        ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
            async { Err("the settings file cannot be read".into()) }.boxed()
        }
    }

    let harness = Harness::new().await;
    let session_id = test_session_id();
    harness.insert_entry("waiting", session_id, AttentionTrigger::PendingApproval);
    let settings = read_notification_settings(&Unreadable).await;

    write_decisions(
        &harness.writer,
        &[decided(
            "waiting",
            session_id,
            settings.as_ref(),
            AttentionTrigger::PendingApproval,
            None,
        )],
    )
    .await
    .expect("the decision is written");

    assert_eq!(
        harness.delivery_of("waiting"),
        (
            Some(<&'static str>::from(AttentionBannerState::Withheld).to_owned()),
            None
        )
    );
}

// A mute that commits after the decision read the session unmuted still withholds the end's banner
// and its web-address message, while the session's wait keeps its pending banner. Killed by the
// write's mute guard dropped.
#[tokio::test]
async fn a_mute_after_the_decision_read_withholds_the_end_it_decided() {
    let harness = Harness::new().await;
    let session_id = test_session_id();
    insert_session_row(
        &harness.database.reader(),
        session_id.text().as_str(),
        None,
        None,
    );
    let mut settings = MachineSettings::default().notifications;
    settings.web_address.enabled = true;
    harness.insert_entry("waiting", session_id, AttentionTrigger::PendingApproval);
    harness.insert_entry("finished", session_id, AttentionTrigger::RunCompleted);
    let decisions = [
        decided(
            "waiting",
            session_id,
            Some(&settings),
            AttentionTrigger::PendingApproval,
            None,
        ),
        decided(
            "finished",
            session_id,
            Some(&settings),
            AttentionTrigger::RunCompleted,
            None,
        ),
    ];
    harness
        .database
        .reader()
        .execute(
            "UPDATE sessions SET muted_at = ?1 WHERE id = ?2",
            params![MUTED_AT, session_id.to_string()],
        )
        .expect("the test mutes the session");

    write_decisions(&harness.writer, &decisions)
        .await
        .expect("the decisions are written");

    let pending = <&'static str>::from(AttentionBannerState::Pending).to_owned();
    let withheld = <&'static str>::from(AttentionBannerState::Withheld).to_owned();
    assert_eq!(
        harness.delivery_of("waiting"),
        (Some(pending), Some("pending".to_owned()))
    );
    assert_eq!(harness.delivery_of("finished"), (Some(withheld), None));
}
