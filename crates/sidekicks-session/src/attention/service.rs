//! The attention service: the task that decides each entry's banner and web-address message once,
//! the settle that records what main did with a banner, the seen mark, and the sweep at start of
//! what a stop left undecided or standing.
//!
//! The decision task follows the machine's change count and reads the undecided entries. A
//! subject's first undecided entry opens a fixed half-second window that later entries do not
//! extend; at its close the gate decides every undecided entry of the subject from one settings
//! read and one snapshot of the entries and their sessions' mutes, and the newest open wait the
//! gate lets through, else the newest end, keeps its banner while the others it lets through merge
//! into it. A Notify step's entry is the person's own instruction and is decided at once, never
//! merged.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use jiff::Timestamp;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, Row};
use sidekicks_contracts::attention::{
    AttentionBannerSettledState, AttentionBannerState, AttentionId, AttentionSeenSubject,
    AttentionSeverity, AttentionTrigger,
};
use sidekicks_contracts::machine::settings::NotificationSettings;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::presence::PresenceRegister;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::attention::banner_launcher::BannerLauncher;
use crate::attention::changes::AttentionChanges;
use crate::attention::gate::{
    Decision, DeliveryDecision, decide, read_notification_settings, write_decisions,
};
use crate::attention::moment::AttentionSubject;
use crate::attention::projection::{
    binding, raised_banner_states, session_binding, statement, version_bump_sql,
};
use crate::attention::retention::{ENTRY_SEQUENCE, advance_retention_statements};
use crate::attention::seen::write_seen;
use crate::directory::lookups::SessionWriteError;

/// The statements the service prepares on a read connection: the undecided entries, the sessions
/// with entries and an entry's session.
pub const ATTENTION_SERVICE_STATEMENT_CAPACITY: usize = 3;

/// How long a subject's first undecided entry waits for the entries that follow it.
const MERGE_WINDOW: Duration = Duration::from_millis(500);

// Every entry whose banner is undecided, with no delivery row or a banner handed back, with its
// source event's sequence and its session's mute, read in one snapshot.
static UNDECIDED_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT attention_entries.id, attention_entries.session_id,
    attention_entries.workflow_run_id, attention_entries.trigger, attention_entries.severity,
    attention_entries.resolved_at IS NOT NULL, {ENTRY_SEQUENCE}, session_row.muted_at
  FROM attention_entries
  LEFT JOIN attention_deliveries AS delivery ON delivery.entry_id = attention_entries.id
  LEFT JOIN sessions AS session_row ON session_row.id = attention_entries.session_id
  WHERE delivery.banner_state IS NULL"
    )
});

// The sessions with attention entries: each has its counts' row, which the raise that made the
// entries wrote.
const SESSIONS_WITH_ENTRIES_SQL: &str =
    "SELECT scope_key FROM attention_versions WHERE scope_key <> ''";

const ENTRY_SESSION_SQL: &str = "SELECT session_id FROM attention_entries WHERE id = ?1";

// A resolved entry's banner a stop left standing.
static STANDING_RESOLVED_BANNERS: LazyLock<String> = LazyLock::new(|| {
    format!(
        "banner_state IN ({raised}) AND entry_id IN (SELECT id FROM attention_entries
    WHERE session_id = @session_id AND resolved_at IS NOT NULL)",
        raised = raised_banner_states(),
    )
});

static BUMP_IF_STANDING_RESOLVED_BANNERS_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(&format!(
        "EXISTS (SELECT 1 FROM attention_deliveries WHERE {})",
        *STANDING_RESOLVED_BANNERS
    ))
});

static WITHDRAW_STANDING_RESOLVED_BANNERS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE attention_deliveries SET banner_state = '{withdrawn}' WHERE {standing}",
        withdrawn = <&'static str>::from(AttentionBannerState::Withdrawn),
        standing = *STANDING_RESOLVED_BANNERS,
    )
});

// The entry's banner while main may still settle it.
static PENDING_BANNER: LazyLock<String> = LazyLock::new(|| {
    format!(
        "entry_id = @entry_id AND banner_state = '{pending}'",
        pending = <&'static str>::from(AttentionBannerState::Pending),
    )
});

static BUMP_IF_PENDING_BANNER_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(&format!(
        "EXISTS (SELECT 1 FROM attention_deliveries WHERE {})",
        *PENDING_BANNER
    ))
});

static SETTLE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE attention_deliveries SET banner_state = @state WHERE {}",
        *PENDING_BANNER
    )
});

/// What the attention service works over.
pub struct AttentionServiceDependencies {
    /// The writer every decision, settle and seen mark goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The read pool the undecided entries are read on.
    pub pool: Arc<DatabaseReadPool>,
    /// The change counts the decision task follows.
    pub changes: AttentionChanges,
    /// The machine's settings file, read once per decision batch.
    pub settings: Arc<dyn MachineSettingsReader>,
    /// The devices connected, which say whether an app window is in front anywhere.
    pub presence: Arc<PresenceRegister>,
    /// The app's windowless start, asked after a batch wrote a pending banner.
    pub launcher: Arc<BannerLauncher>,
    /// This machine's device, the one whose main process settles its banners.
    pub machine_device_id: DeviceId,
}

/// Decides, settles and marks seen the attention entries, and sweeps what a stop left behind.
pub struct AttentionService {
    writer: Arc<DatabaseWriter>,
    pool: Arc<DatabaseReadPool>,
    changes: AttentionChanges,
    settings: Arc<dyn MachineSettingsReader>,
    presence: Arc<PresenceRegister>,
    launcher: Arc<BannerLauncher>,
    machine_device_id: DeviceId,
}

/// Why the attention service could not read or write its rows.
#[derive(Debug, thiserror::Error)]
pub enum AttentionServiceError {
    /// The write was not kept.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// SQLite refused a read, or a stored value does not read as its column's.
    #[error("a read of the attention entries failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// One undecided entry as the gate reads it.
struct UndecidedEntry {
    id: String,
    session_id: SessionId,
    subject: AttentionSubject,
    trigger: AttentionTrigger,
    severity: AttentionSeverity,
    is_resolved: bool,
    // The source event's sequence, which orders a subject's entries.
    sequence: Option<i64>,
    // The session's mute in the stored form; `None` while unmuted.
    muted_at: Option<String>,
}

impl UndecidedEntry {
    /// A row of [`UNDECIDED_ENTRIES_SQL`].
    fn of_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let session_id = text_column(row, 1, |text| SessionId::new(&text))?;
        let workflow_run_id = optional_text_column(row, 2, |text| WorkflowRunId::new(&text))?;
        Ok(Self {
            id: row.get(0)?,
            session_id,
            subject: workflow_run_id
                .map_or(AttentionSubject::Session(session_id), |workflow_run_id| {
                    AttentionSubject::WorkflowRun(workflow_run_id)
                }),
            trigger: text_column(row, 3, closed_word)?,
            severity: text_column(row, 4, closed_word)?,
            is_resolved: row.get(5)?,
            sequence: row.get(6)?,
            muted_at: row.get(7)?,
        })
    }

    /// The gate's decision for this entry, as the settings and presence read now say.
    fn decision(&self, settings: Option<&NotificationSettings>, is_app_in_front: bool) -> Decision {
        decide(
            settings,
            self.trigger,
            self.muted_at.is_some(),
            self.is_resolved,
            is_app_in_front,
        )
    }

    /// The write of `decision` for this entry, merged into `merged_into` when given.
    fn delivery(&self, decision: Decision, merged_into: Option<String>) -> DeliveryDecision {
        DeliveryDecision {
            entry_id: self.id.clone(),
            session_id: self.session_id,
            decision,
            merged_into,
            muted_at: self.muted_at.clone(),
        }
    }
}

impl AttentionService {
    /// The service over `dependencies`; nothing runs until [`AttentionService::start`].
    pub fn new(dependencies: AttentionServiceDependencies) -> Self {
        Self {
            writer: dependencies.writer,
            pool: dependencies.pool,
            changes: dependencies.changes,
            settings: dependencies.settings,
            presence: dependencies.presence,
            launcher: dependencies.launcher,
            machine_device_id: dependencies.machine_device_id,
        }
    }

    /// Run once after the recovery pass: withdraws a resolved entry's banner a stop left standing,
    /// withholds the banner of every entry a stop left undecided but an open wait, whose web
    /// address is still decided unless it resolved, advances every session's retention cut, then
    /// starts the decision task, which the open waits go through and which ends with `stop`. Fails
    /// when the sweep's reads or writes fail, before the task starts.
    pub async fn start(
        self: &Arc<Self>,
        stop: CancellationToken,
    ) -> Result<JoinHandle<()>, AttentionServiceError> {
        let sessions = self.read_sessions_with_entries().await?;
        self.sweep_after_stop(&sessions).await?;
        let now = Timestamp::now();
        let retention = sessions
            .iter()
            .flat_map(|session_id| advance_retention_statements(*session_id, now))
            .collect::<Vec<_>>();
        if !retention.is_empty() {
            self.writer.write(retention).await?;
        }
        let count = self.changes.follow(None);
        Ok(tokio::spawn(run_decisions(
            DecisionTask::new(Arc::clone(self)),
            count,
            stop,
        )))
    }

    /// Records what main did with `entry_id`'s pending banner. Ignored unless `device_id` is this
    /// machine's, for an entry with no row, and once the banner left `pending`.
    pub async fn settle(
        &self,
        entry_id: &AttentionId,
        state: AttentionBannerSettledState,
        device_id: Option<&DeviceId>,
    ) -> Result<(), AttentionServiceError> {
        if device_id != Some(&self.machine_device_id) {
            return Ok(());
        }
        let entry = entry_id.as_str().to_owned();
        let Some(session_id) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                read_entry_session(connection, &entry)
            })
            .await?
        else {
            return Ok(());
        };
        let state = match state {
            AttentionBannerSettledState::Posted => AttentionBannerState::Posted,
            AttentionBannerSettledState::Withheld => AttentionBannerState::Withheld,
            AttentionBannerSettledState::Withdrawn => AttentionBannerState::Withdrawn,
        };
        let entry = || binding("@entry_id", Value::Text(entry_id.as_str().to_owned()));
        self.writer
            .write(vec![
                statement(
                    &BUMP_IF_PENDING_BANNER_SQL,
                    vec![session_binding(session_id), entry()],
                ),
                statement(
                    &SETTLE_SQL,
                    vec![
                        entry(),
                        binding(
                            "@state",
                            Value::Text(<&'static str>::from(state).to_owned()),
                        ),
                    ],
                ),
            ])
            .await?;
        Ok(())
    }

    /// Marks `subject` seen through its session's newest event; fails as [`write_seen`] does.
    pub async fn mark_seen(&self, subject: &AttentionSeenSubject) -> Result<(), SessionWriteError> {
        write_seen(&self.writer, subject).await
    }

    // Withdraws each resolved entry's standing banner, then decides each undecided entry but an
    // open wait: a resolved one withheld on every channel, any other its banner withheld and its
    // web address by the gate.
    async fn sweep_after_stop(&self, sessions: &[SessionId]) -> Result<(), AttentionServiceError> {
        let withdrawals = sessions
            .iter()
            .flat_map(|session_id| {
                [
                    statement(
                        &BUMP_IF_STANDING_RESOLVED_BANNERS_SQL,
                        vec![session_binding(*session_id)],
                    ),
                    statement(
                        &WITHDRAW_STANDING_RESOLVED_BANNERS_SQL,
                        vec![session_binding(*session_id)],
                    ),
                ]
            })
            .collect::<Vec<WriteStatement>>();
        if !withdrawals.is_empty() {
            self.writer.write(withdrawals).await?;
        }
        let undecided = self.read_undecided().await?;
        let crash_undecided = undecided
            .iter()
            .filter(|entry| entry.is_resolved || entry.severity != AttentionSeverity::Actionable)
            .collect::<Vec<_>>();
        if crash_undecided.is_empty() {
            return Ok(());
        }
        let settings = read_notification_settings(&*self.settings).await;
        let is_app_in_front = self.presence.is_app_visible_on_any_device();
        let decisions = crash_undecided
            .into_iter()
            .map(|entry| {
                let decision = Decision {
                    banner_state: AttentionBannerState::Withheld,
                    ..entry.decision(settings.as_ref(), is_app_in_front)
                };
                entry.delivery(decision, None)
            })
            .collect::<Vec<_>>();
        write_decisions(&self.writer, &decisions).await?;
        Ok(())
    }

    // Decides `notify` each on its own and every entry of each closed window as one merge, in one
    // write; then asks for the app's start when a banner went pending, and advances the decided
    // sessions' retention.
    async fn decide_batch(
        &self,
        notify: Vec<UndecidedEntry>,
        closed: Vec<Vec<UndecidedEntry>>,
    ) -> Result<(), AttentionServiceError> {
        let settings = read_notification_settings(&*self.settings).await;
        let is_app_in_front = self.presence.is_app_visible_on_any_device();
        let mut decisions = notify
            .iter()
            .map(|entry| entry.delivery(entry.decision(settings.as_ref(), is_app_in_front), None))
            .collect::<Vec<_>>();
        for window in &closed {
            decisions.extend(merged_decisions(window, |entry| {
                entry.decision(settings.as_ref(), is_app_in_front)
            }));
        }
        write_decisions(&self.writer, &decisions).await?;
        if decisions
            .iter()
            .any(|decided| decided.decision.banner_state == AttentionBannerState::Pending)
        {
            self.launcher.request_start();
        }
        let mut sessions: Vec<SessionId> = Vec::new();
        for decided in &decisions {
            if !sessions.contains(&decided.session_id) {
                sessions.push(decided.session_id);
            }
        }
        let now = Timestamp::now();
        self.writer
            .write(
                sessions
                    .into_iter()
                    .flat_map(|session_id| advance_retention_statements(session_id, now))
                    .collect(),
            )
            .await?;
        Ok(())
    }

    async fn read_undecided(&self) -> Result<Vec<UndecidedEntry>, AttentionServiceError> {
        self.pool
            .read(ReadLength::Short, |connection| {
                let snapshot = connection.unchecked_transaction()?;
                let entries = snapshot
                    .prepare_cached(&UNDECIDED_ENTRIES_SQL)?
                    .query_map([], UndecidedEntry::of_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                snapshot.commit()?;
                Ok(entries)
            })
            .await
    }

    async fn read_sessions_with_entries(&self) -> Result<Vec<SessionId>, AttentionServiceError> {
        self.pool
            .read(ReadLength::Short, |connection| {
                Ok(connection
                    .prepare_cached(SESSIONS_WITH_ENTRIES_SQL)?
                    .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }
}

fn read_entry_session(
    connection: &Connection,
    entry_id: &str,
) -> Result<Option<SessionId>, AttentionServiceError> {
    Ok(connection
        .prepare_cached(ENTRY_SESSION_SQL)?
        .query_row([entry_id], |row| {
            text_column(row, 0, |text| SessionId::new(&text))
        })
        .optional()?)
}

/// The decisions of one subject's closed window: each entry as `decision_of` decides it, and of
/// those it lets raise a banner only the newest open wait keeps it, else the newest end, the others
/// withheld and merged into it. An entry the gate withholds on its own never merges.
fn merged_decisions(
    window: &[UndecidedEntry],
    decision_of: impl Fn(&UndecidedEntry) -> Decision,
) -> Vec<DeliveryDecision> {
    let decided = window
        .iter()
        .map(|entry| (entry, decision_of(entry)))
        .collect::<Vec<_>>();
    let picked = decided
        .iter()
        .filter(|(_, decision)| decision.banner_state == AttentionBannerState::Pending)
        .max_by_key(|(entry, _)| {
            (
                entry.severity == AttentionSeverity::Actionable,
                entry.sequence,
                entry.id.as_str(),
            )
        })
        .map(|(entry, _)| entry.id.clone());
    decided
        .into_iter()
        .map(|(entry, decision)| match &picked {
            Some(picked)
                if decision.banner_state == AttentionBannerState::Pending
                    && entry.id != *picked =>
            {
                entry.delivery(
                    Decision {
                        banner_state: AttentionBannerState::Withheld,
                        ..decision
                    },
                    Some(picked.clone()),
                )
            }
            Some(_) | None => entry.delivery(decision, None),
        })
        .collect()
}

/// The decision task's windows: when each subject's open window closes.
struct DecisionTask {
    service: Arc<AttentionService>,
    windows: HashMap<AttentionSubject, Instant>,
}

impl DecisionTask {
    fn new(service: Arc<AttentionService>) -> Self {
        Self {
            service,
            windows: HashMap::new(),
        }
    }

    /// Reads the undecided entries, opens a window for each subject that has none, decides the
    /// Notify entries and every subject whose window has closed, and answers when the next open
    /// window closes. A failed decision keeps the closed windows, closing again a window later.
    async fn pass(&mut self) -> Result<Option<Instant>, AttentionServiceError> {
        let undecided = self.service.read_undecided().await?;
        let now = Instant::now();
        let mut notify = Vec::new();
        let mut by_subject: HashMap<AttentionSubject, Vec<UndecidedEntry>> = HashMap::new();
        for entry in undecided {
            if entry.trigger == AttentionTrigger::WorkflowNotify {
                notify.push(entry);
            } else {
                by_subject.entry(entry.subject).or_default().push(entry);
            }
        }
        self.windows
            .retain(|subject, _| by_subject.contains_key(subject));
        let mut closed_subjects = Vec::new();
        let mut closed = Vec::new();
        for (subject, entries) in by_subject {
            let closes_at = *self.windows.entry(subject).or_insert(now + MERGE_WINDOW);
            if closes_at <= now {
                closed_subjects.push(subject);
                closed.push(entries);
            }
        }
        if !notify.is_empty() || !closed.is_empty() {
            if let Err(error) = self.service.decide_batch(notify, closed).await {
                for subject in closed_subjects {
                    self.windows.insert(subject, now + MERGE_WINDOW);
                }
                return Err(error);
            }
            for subject in &closed_subjects {
                self.windows.remove(subject);
            }
        }
        Ok(self.windows.values().min().copied())
    }
}

// Passes over the undecided entries at once, then whenever the machine's count moves or a window
// closes, until `stop`; a failed pass is logged and the next wake reads again.
async fn run_decisions(
    mut task: DecisionTask,
    mut count: tokio::sync::watch::Receiver<u64>,
    stop: CancellationToken,
) {
    loop {
        let next_close = match task.pass().await {
            Ok(next_close) => next_close,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the attention entries were not decided; the next change or window reads them \
                     again"
                );
                task.windows.values().min().copied()
            }
        };
        let window_closes = async {
            match next_close {
                Some(closes_at) => tokio::time::sleep_until(closes_at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = stop.cancelled() => return,
            changed = count.changed() => {
                if changed.is_err() {
                    return;
                }
            }
            () = window_closes => {}
        }
    }
}

#[cfg(test)]
mod tests;
