//! A session names itself after its first completed exchange. One short pass of the session's own
//! provider reads the first message and the first reply and proposes a name; when it returns
//! nothing, fails or runs past its bound, the first words of the first message are the name. The
//! name is written through the naming path only while the session is still unnamed, so a name the
//! person typed, before or during, always wins, and a rename while the pass runs cancels it. A
//! session whose first exchange completed while the daemon was not following it is named at the
//! next start, one session at a time.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::stored_column::text_column;
use crate::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::session_control::{NAME_SESSION_REPLY_MAX_BYTES, NameSessionParams};
use crate::session::changes::SessionChanges;
use crate::session::run::read::read_run_provider;
use crate::session::working_folder::{WorkingFolderReadError, read_working_folder};
use crate::text_cut::cut_to_code_points;

/// The statements the self-naming prepares on a read connection: an earlier completion, the name
/// and first message, the first completed run, its reply, the unnamed sessions, the session's
/// working folder and the run's provider.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start sizes the read connections' statement caches with it"
    )
)]
pub(crate) const SESSION_AUTO_TITLE_STATEMENT_CAPACITY: usize = 7;

/// A fallback name reads as a few words: whole words up to this many code points.
const FALLBACK_NAME_MAX_CODE_POINTS: usize = 40;

/// How long one naming pass may run before it counts as having returned nothing.
const NAMING_PASS_TIMEOUT: Duration = Duration::from_secs(30);

/// What joins one reply message to the next in the reply the pass reads.
const REPLY_MESSAGE_SEPARATOR: &str = "\n\n";

const EARLIER_COMPLETION_SQL: &str = "SELECT 1 FROM session_events
  WHERE session_id = @sessionId AND type = @completedType AND sequence < @sequence
  LIMIT 1";

const NAMING_SOURCE_SQL: &str = "SELECT name, first_message_preview FROM sessions
  WHERE id = @sessionId";

const FIRST_COMPLETED_RUN_SQL: &str = "SELECT run_id FROM session_events
  WHERE session_id = @sessionId AND type = @completedType AND run_id IS NOT NULL
  ORDER BY sequence LIMIT 1";

const RUN_REPLY_SQL: &str = "SELECT content_payload FROM session_events
  WHERE session_id = @sessionId AND type = @messageType AND run_id = @runId
    AND content_payload IS NOT NULL
  ORDER BY sequence";

// A session never renamed whose exchange completed; one the person cleared has a rename and stays
// unnamed. Oldest first, so a backlog is named in the order it was made.
const UNNAMED_COMPLETED_SQL: &str = "SELECT session.id FROM sessions AS session
  WHERE session.name IS NULL AND session.first_message_preview IS NOT NULL
    AND EXISTS (SELECT 1 FROM session_events
                 WHERE session_id = session.id AND type = @completedType)
    AND NOT EXISTS (SELECT 1 FROM session_events
                     WHERE session_id = session.id AND type = @renamedType)
  ORDER BY session.id";

/// Why the naming inputs did not read.
#[derive(Debug, thiserror::Error)]
enum NamingReadError {
    /// SQLite refused a read, or a stored id did not read.
    #[error("a read of the session's first exchange failed")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The session's place did not read.
    #[error(transparent)]
    WorkingFolder(#[from] WorkingFolderReadError),
}

/// What one session's naming reads: its first message, where it runs, the provider of its first
/// completed run, and that run's reply cut to the pass's bound.
struct NamingInput {
    first_message: String,
    place: Option<Place>,
    provider: Option<ProviderId>,
    first_reply: String,
}

/// A naming pass still under way, and the count that tells it from a later pass of its session.
struct PendingPass {
    generation: u64,
    cancel: CancellationToken,
}

/// Every pending pass by session; a session has at most one.
#[derive(Default)]
struct PendingPasses {
    next_generation: u64,
    by_session: HashMap<SessionId, PendingPass>,
}

/// Names each unnamed session after its first completed exchange, from
/// [`SessionAutoTitle::start`] until [`SessionAutoTitling::stop`].
pub(crate) struct SessionAutoTitle {
    pool: Arc<DatabaseReadPool>,
    changes: Arc<SessionChanges>,
    providers: Arc<ProviderRegistry>,
    /// Every naming task, so the stop waits for each.
    passes: TaskTracker,
    /// Cancelled at the stop; each pass's token is a child of it.
    stopping: CancellationToken,
    pending: Mutex<PendingPasses>,
}

/// The follow of every session's committed events and the naming tasks, from
/// [`SessionAutoTitle::start`] until [`SessionAutoTitling::stop`].
pub(crate) struct SessionAutoTitling {
    /// Hears every committed completion and rename; dropping it detaches.
    attachment: FollowerAttachment,
    auto_title: Arc<SessionAutoTitle>,
}

impl SessionAutoTitling {
    /// Stops hearing committed events, cancels every pass under way, which then writes nothing,
    /// and settles once every naming task has ended.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's stop ends the session self-naming")
    )]
    pub(crate) async fn stop(self) {
        let Self {
            attachment,
            auto_title,
        } = self;
        drop(attachment);
        auto_title.stopping.cancel();
        auto_title.passes.close();
        auto_title.passes.wait().await;
    }
}

impl SessionAutoTitle {
    /// The self-naming reading through `pool`, writing each name through `changes` and running
    /// each pass on the session's driver among `providers`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start builds the session self-naming"
        )
    )]
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        changes: Arc<SessionChanges>,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        Self {
            pool,
            changes,
            providers,
            passes: TaskTracker::new(),
            stopping: CancellationToken::new(),
            pending: Mutex::new(PendingPasses::default()),
        }
    }

    /// Follows every committed completion and rename of `followers`, then names, one at a time,
    /// each session whose first exchange completed while none was followed. Called inside the
    /// daemon's runtime, whose handle every naming task is spawned on.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start runs the session self-naming")
    )]
    pub(crate) fn start(
        self: &Arc<Self>,
        followers: &Arc<SessionEventFollowers>,
    ) -> SessionAutoTitling {
        let runtime = Handle::current();
        let auto_title = Arc::clone(self);
        let follower_runtime = runtime.clone();
        // Runs on the writer's pump, so it only spawns the pass or cancels it.
        let attachment = followers.follow_all(move |event| {
            let session_id = event.envelope.session_id();
            let event_type = event.envelope.event_type();
            if event_type == SessionEventType::AgentRunCompleted {
                auto_title.spawn_pass(session_id, event.sequence, &follower_runtime);
            } else if event_type == SessionEventType::SessionRenamed {
                auto_title.cancel_pass(session_id);
            }
            Ok(())
        });
        self.passes
            .spawn_on(Arc::clone(self).name_unfollowed_sessions(), &runtime);
        SessionAutoTitling {
            attachment,
            auto_title: Arc::clone(self),
        }
    }

    // Starts the pass after `session_id`'s completion at `sequence`, unless one is under way.
    fn spawn_pass(self: &Arc<Self>, session_id: SessionId, sequence: SafeInt<0>, runtime: &Handle) {
        let Some((generation, cancel)) = self.register_pass(session_id) else {
            return;
        };
        let auto_title = Arc::clone(self);
        self.passes.spawn_on(
            async move {
                auto_title
                    .name_session(session_id, Some(sequence), &cancel)
                    .await;
                auto_title.release_pass(session_id, generation);
            },
            runtime,
        );
    }

    // Names each session that completed an exchange while unfollowed, one at a time, so a backlog
    // costs one pass at a time.
    async fn name_unfollowed_sessions(self: Arc<Self>) {
        let unnamed = match self
            .pool
            .read(ReadLength::Long, |reader| {
                Ok::<_, NamingReadError>(read_unnamed_completed(reader)?)
            })
            .await
        {
            Ok(unnamed) => unnamed,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the sessions that completed an exchange unnamed did not read; none is named \
                     until the next start"
                );
                return;
            }
        };
        for session_id in unnamed {
            if self.stopping.is_cancelled() {
                return;
            }
            let Some((generation, cancel)) = self.register_pass(session_id) else {
                continue;
            };
            self.name_session(session_id, None, &cancel).await;
            self.release_pass(session_id, generation);
        }
    }

    // Names the session from its first exchange: the pass's name, or the first message's first
    // words when the pass returns nothing. A completion at `completed_at` names it only when it is
    // the first; a cancelled pass writes nothing.
    async fn name_session(
        &self,
        session_id: SessionId,
        completed_at: Option<SafeInt<0>>,
        cancel: &CancellationToken,
    ) {
        let input = match self
            .pool
            .read(ReadLength::Long, move |reader| {
                read_naming_input(reader, &session_id, completed_at)
            })
            .await
        {
            Ok(Some(input)) => input,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    session_id = session_id.text().as_str(),
                    "the session's first exchange did not read, so it was not named"
                );
                return;
            }
        };
        let first_message = input.first_message.clone();
        let passed_name = self.run_pass(session_id, input, cancel).await;
        if cancel.is_cancelled() {
            return;
        }
        let name = passed_name.unwrap_or_else(|| first_words_of(&first_message));
        if let Err(error) = self.changes.name_unnamed(session_id, &name).await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                session_id = session_id.text().as_str(),
                "naming the session after its first exchange failed"
            );
        }
    }

    // One bounded pass on the driver of the session's first completed run; `None` when it
    // returned nothing, failed, ran past its bound or was cancelled, or no driver answers.
    async fn run_pass(
        &self,
        session_id: SessionId,
        input: NamingInput,
        cancel: &CancellationToken,
    ) -> Option<String> {
        let provider = input.provider?;
        let driver = match self.providers.lookup(&provider) {
            Ok(driver) => driver,
            Err(refusal) => {
                tracing::warn!(
                    error = &refusal as &(dyn Error + 'static),
                    session_id = session_id.text().as_str(),
                    provider = provider.as_str(),
                    "no driver ran the session's naming pass"
                );
                return None;
            }
        };
        let pass_cancel = cancel.child_token();
        // The driver's work is told to end however this pass ends.
        let _ends_pass = pass_cancel.clone().drop_guard();
        let params = NameSessionParams {
            session_id,
            place: input.place,
            first_message: input.first_message,
            first_reply: input.first_reply,
            cancel: pass_cancel,
        };
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => return None,
            outcome = tokio::time::timeout(NAMING_PASS_TIMEOUT, driver.name_session(params)) => {
                outcome
            }
        };
        match outcome {
            Ok(Ok(Some(name))) if !name.trim_matches(is_ecmascript_whitespace).is_empty() => {
                Some(name)
            }
            Ok(Ok(Some(_) | None)) => None,
            Ok(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    session_id = session_id.text().as_str(),
                    "the session's naming pass failed; its first words name it"
                );
                None
            }
            Err(elapsed) => {
                tracing::warn!(
                    error = &elapsed as &(dyn Error + 'static),
                    session_id = session_id.text().as_str(),
                    "the session's naming pass ran past its bound; its first words name it"
                );
                None
            }
        }
    }

    // Marks a pass of `session_id` as under way, with a token cancelled by a rename or the stop;
    // `None` when one already is.
    fn register_pass(&self, session_id: SessionId) -> Option<(u64, CancellationToken)> {
        let mut pending = self.lock_pending();
        if pending.by_session.contains_key(&session_id) {
            return None;
        }
        let generation = pending.next_generation;
        pending.next_generation += 1;
        let cancel = self.stopping.child_token();
        pending.by_session.insert(
            session_id,
            PendingPass {
                generation,
                cancel: cancel.clone(),
            },
        );
        Some((generation, cancel))
    }

    // Forgets the pass `generation` of `session_id` once it ended, never a later one.
    fn release_pass(&self, session_id: SessionId, generation: u64) {
        let mut pending = self.lock_pending();
        if pending
            .by_session
            .get(&session_id)
            .is_some_and(|pass| pass.generation == generation)
        {
            pending.by_session.remove(&session_id);
        }
    }

    // A rename landed: the session's pass under way ends and writes nothing.
    fn cancel_pass(&self, session_id: SessionId) {
        let cancelled = self.lock_pending().by_session.remove(&session_id);
        if let Some(pass) = cancelled {
            pass.cancel.cancel();
        }
    }

    fn lock_pending(&self) -> MutexGuard<'_, PendingPasses> {
        // The map holds no invariant a panicking holder could break.
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The fallback name a session takes from its first message: the message's whole words, split at
/// ECMAScript whitespace and joined by single spaces, up to 40 code points; a first word longer
/// than that is cut at it. Empty when the message has no words.
pub(crate) fn first_words_of(message: &str) -> String {
    let mut words = message
        .split(is_ecmascript_whitespace)
        .filter(|word| !word.is_empty());
    let Some(first_word) = words.next() else {
        return String::new();
    };
    let mut code_points = first_word.chars().count();
    if code_points > FALLBACK_NAME_MAX_CODE_POINTS {
        return cut_to_code_points(first_word, FALLBACK_NAME_MAX_CODE_POINTS).to_owned();
    }
    let mut name = first_word.to_owned();
    for word in words {
        let extended = code_points + 1 + word.chars().count();
        if extended > FALLBACK_NAME_MAX_CODE_POINTS {
            break;
        }
        name.push(' ');
        name.push_str(word);
        code_points = extended;
    }
    name
}

// What `session_id`'s naming reads, in one snapshot; `None` when the completion at
// `completed_at` is not the session's first, or the session is gone, named or has no first
// message.
fn read_naming_input(
    reader: &Connection,
    session_id: &SessionId,
    completed_at: Option<SafeInt<0>>,
) -> Result<Option<NamingInput>, NamingReadError> {
    let snapshot = reader.unchecked_transaction()?;
    let session = session_id.text();
    let completed_type = SessionEventType::AgentRunCompleted.as_str();
    if let Some(sequence) = completed_at {
        let is_later = snapshot
            .prepare_cached(EARLIER_COMPLETION_SQL)?
            .exists(named_params! {
                "@sessionId": session.as_str(),
                "@completedType": completed_type,
                "@sequence": i64::from(sequence),
            })?;
        if is_later {
            return Ok(None);
        }
    }
    let source = snapshot
        .prepare_cached(NAMING_SOURCE_SQL)?
        .query_row(named_params! { "@sessionId": session.as_str() }, |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })
        .optional()?;
    let Some((None, Some(first_message))) = source else {
        return Ok(None);
    };
    let place = read_working_folder(&snapshot, session_id)?.place;
    let first_run = snapshot
        .prepare_cached(FIRST_COMPLETED_RUN_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session.as_str(),
                "@completedType": completed_type,
            },
            |row| text_column(row, 0, |text| RunId::new(&text)),
        )
        .optional()?;
    let (provider, first_reply) = match first_run {
        Some(run_id) => (
            read_run_provider(&snapshot, &run_id)?,
            read_run_reply(&snapshot, session_id, &run_id)?,
        ),
        None => (None, String::new()),
    };
    Ok(Some(NamingInput {
        first_message,
        place,
        provider,
        first_reply,
    }))
}

// The run's reply messages in order, joined, read only as far as the pass's bound and cut there
// at a character boundary. A body that is not UTF-8 reads with U+FFFD, since the pass only reads
// it.
fn read_run_reply(
    reader: &Connection,
    session_id: &SessionId,
    run_id: &RunId,
) -> rusqlite::Result<String> {
    let mut statement = reader.prepare_cached(RUN_REPLY_SQL)?;
    let mut rows = statement.query(named_params! {
        "@sessionId": session_id.text().as_str(),
        "@messageType": SessionEventType::AgentMessageSent.as_str(),
        "@runId": run_id.text().as_str(),
    })?;
    let mut reply = String::new();
    while reply.len() < NAME_SESSION_REPLY_MAX_BYTES
        && let Some(row) = rows.next()?
    {
        let body: Vec<u8> = row.get(0)?;
        if !reply.is_empty() {
            reply.push_str(REPLY_MESSAGE_SEPARATOR);
        }
        reply.push_str(&String::from_utf8_lossy(&body));
    }
    let end = reply.floor_char_boundary(NAME_SESSION_REPLY_MAX_BYTES);
    reply.truncate(end);
    Ok(reply)
}

fn read_unnamed_completed(reader: &Connection) -> rusqlite::Result<Vec<SessionId>> {
    reader
        .prepare_cached(UNNAMED_COMPLETED_SQL)?
        .query_map(
            named_params! {
                "@completedType": SessionEventType::AgentRunCompleted.as_str(),
                "@renamedType": SessionEventType::SessionRenamed.as_str(),
            },
            |row| text_column(row, 0, |text| SessionId::new(&text)),
        )?
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use futures::FutureExt as _;
    use mockall::Sequence;
    use rstest::rstest;
    use rusqlite::params;
    use serde_json::Value;
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::SessionRenameRequest;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_platforms::Spawner;
    use tokio::runtime::Handle;
    use tokio::sync::Notify;

    use super::{SESSION_AUTO_TITLE_STATEMENT_CAPACITY, SessionAutoTitle, first_words_of};
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::events::log_service::tests::{TestLog, open_log};
    use crate::provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use crate::provider::driver::registry::ProviderRegistry;
    use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};
    use crate::session::changes::{SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges};
    use crate::session::directory::test_rows::insert_session_row;
    use crate::uuid_v7::mint_uuid_v7;

    /// Bounds every wait a test expects to end, so one that never does fails the test.
    const WAIT: Duration = Duration::from_secs(10);

    /// The session's stored renames, oldest first: each name and who gave it.
    const STORED_RENAMES_SQL: &str = "SELECT payload FROM session_events
      WHERE session_id = ?1 AND type = ?2 ORDER BY sequence";

    /// The self-naming, the changes a test renames through, and the log they share.
    struct Harness {
        database: TestDatabase,
        log: TestLog,
        changes: Arc<SessionChanges>,
        auto_title: Arc<SessionAutoTitle>,
    }

    /// The self-naming on a fresh database whose one provider's driver `build` makes.
    async fn harness(build: fn(&DriverServices) -> Arc<dyn ProviderDriver>) -> Harness {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let services = DriverServices {
            spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
            data_folder: PathBuf::from("data"),
        };
        let providers = Arc::new(ProviderRegistry::register_from(
            &[ProviderRegistration {
                descriptor: PROVIDERS[0],
                build,
            }],
            &services,
        ));
        let changes = Arc::new(SessionChanges::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_CHANGES_STATEMENT_CAPACITY,
            )),
            Arc::clone(&log.service),
            Arc::clone(&providers),
        ));
        let auto_title = Arc::new(SessionAutoTitle::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_AUTO_TITLE_STATEMENT_CAPACITY,
            )),
            Arc::clone(&changes),
            providers,
        ));
        Harness {
            database,
            log,
            changes,
            auto_title,
        }
    }

    /// Stores an unnamed session whose first message was `first_message` and whose first run,
    /// bound to the table's first provider, completed while nothing followed the log.
    fn insert_completed_session(
        database: &TestDatabase,
        session_id: SessionId,
        first_message: &str,
    ) {
        let connection = database.reader();
        let session = session_id.text();
        insert_session_row(&connection, session.as_str(), None, None);
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let run = run_id.text();
        let completed = SessionEventType::AgentRunCompleted;
        connection
            .execute(
                "UPDATE sessions SET first_message_preview = ?2 WHERE id = ?1",
                params![session.as_str(), first_message],
            )
            .expect("the test stores the first message");
        connection
            .execute(
                "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
                   category, type, payload, run_id, run_version)
                 VALUES (?1, ?2, 1, '2026-10-19T09:00:00.000Z', 0, ?3, ?4, '{}', ?5, 1)",
                params![
                    run.as_str(),
                    session.as_str(),
                    completed.category().as_str(),
                    completed.as_str(),
                    run.as_str()
                ],
            )
            .expect("the test stores the completion");
        connection
            .execute(
                "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
                   cli_version_raw, created_at, updated_at)
                 VALUES (?1, ?1, ?2, '1.0.0', '1.0.0', '', '')",
                params![run.as_str(), PROVIDERS[0].id],
            )
            .expect("the test binds the run to its provider");
    }

    /// The session's stored renames, oldest first: each name and its origin.
    fn stored_renames(database: &TestDatabase, session_id: SessionId) -> Vec<(Value, Value)> {
        database
            .reader()
            .prepare(STORED_RENAMES_SQL)
            .expect("the test reads the log")
            .query_map(
                params![
                    session_id.text().as_str(),
                    SessionEventType::SessionRenamed.as_str()
                ],
                |row| row.get::<_, String>(0),
            )
            .expect("the test reads the log")
            .map(|payload| {
                let payload: Value = serde_json::from_str(&payload.expect("a payload reads"))
                    .expect("a stored payload is JSON");
                (payload["name"].clone(), payload["origin"].clone())
            })
            .collect()
    }

    // Killed by the fallback not being written after a pass that returned nothing, and by the
    // naming writing over a name the person gave while the pass ran.
    #[tokio::test]
    async fn auto_title_writes_the_first_words_after_an_empty_pass_and_never_over_a_rename() {
        static PASS_STARTED: Notify = Notify::const_new();
        static PASS_RELEASED: Notify = Notify::const_new();
        fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
            let mut driver = MockProviderDriver::new();
            let mut sequence = Sequence::new();
            driver
                .expect_name_session()
                .times(1)
                .in_sequence(&mut sequence)
                .returning(|_| {
                    async {
                        PASS_STARTED.notify_one();
                        PASS_RELEASED.notified().await;
                        Ok(None)
                    }
                    .boxed()
                });
            driver
                .expect_name_session()
                .times(1)
                .in_sequence(&mut sequence)
                .returning(|_| async { Ok(None) }.boxed());
            driver
                .expect_tell_session_name()
                .returning(|_, _| async { Ok(()) }.boxed());
            Arc::new(driver)
        }
        let harness = harness(build).await;
        // The start names the sessions in id order, so the first is renamed during its pass.
        let mut session_ids = [test_session_id(), test_session_id()];
        session_ids.sort_by_key(|session_id| session_id.text().as_str().to_owned());
        let [renamed_first, unnamed] = session_ids;
        insert_completed_session(&harness.database, renamed_first, "rename this one please");
        insert_completed_session(
            &harness.database,
            unnamed,
            "  tidy up\u{FEFF}the settings page spacing before lunch",
        );
        let mut unnamed_changes = harness.log.followers.change_count(&unnamed);

        let titling = harness.auto_title.start(&harness.log.followers);
        tokio::time::timeout(WAIT, PASS_STARTED.notified())
            .await
            .expect("the first session's pass starts");
        harness
            .database
            .reader()
            .execute(
                "UPDATE sessions SET name = 'Mine' WHERE id = ?1",
                [renamed_first.text().as_str()],
            )
            .expect("the person's name lands");
        PASS_RELEASED.notify_one();
        tokio::time::timeout(WAIT, unnamed_changes.changed())
            .await
            .expect("the second session is named in time")
            .expect("the log is still followed");
        titling.stop().await;

        assert_eq!(stored_renames(&harness.database, renamed_first), []);
        assert_eq!(
            stored_renames(&harness.database, unnamed),
            [(
                Value::from("tidy up the settings page spacing before"),
                Value::from("auto")
            )]
        );
    }

    // Killed by a rename that leaves the pass under way, and by a cancelled pass still writing.
    #[tokio::test]
    async fn auto_title_cancels_a_pending_pass_when_the_session_is_renamed() {
        static PASS_STARTED: Notify = Notify::const_new();
        static PASS_ENDED: Notify = Notify::const_new();
        /// Raises `PASS_ENDED` when the pass's future ends or is dropped.
        struct EndsPass;
        impl Drop for EndsPass {
            fn drop(&mut self) {
                PASS_ENDED.notify_one();
            }
        }
        fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
            let mut driver = MockProviderDriver::new();
            driver.expect_name_session().times(1).returning(|params| {
                async move {
                    let _ends_pass = EndsPass;
                    PASS_STARTED.notify_one();
                    params.cancel.cancelled().await;
                    Ok(Some("Late name".to_owned()))
                }
                .boxed()
            });
            driver
                .expect_tell_session_name()
                .returning(|_, _| async { Ok(()) }.boxed());
            Arc::new(driver)
        }
        let harness = harness(build).await;
        let session_id = test_session_id();
        insert_completed_session(&harness.database, session_id, "fix the login bug");

        let titling = harness.auto_title.start(&harness.log.followers);
        tokio::time::timeout(WAIT, PASS_STARTED.notified())
            .await
            .expect("the pass starts");
        harness
            .changes
            .rename(SessionRenameRequest {
                session_id,
                name: Some(FreeFormText::new("Mine".to_owned()).expect("a name")),
            })
            .await
            .expect("the person's rename is kept");
        tokio::time::timeout(WAIT, PASS_ENDED.notified())
            .await
            .expect("the rename ends the pass before the stop");
        titling.stop().await;

        assert_eq!(
            stored_renames(&harness.database, session_id),
            [(Value::from("Mine"), Value::from("user"))]
        );
    }

    // Killed by splitting at Unicode whitespace instead of ECMAScript's, by counting bytes instead
    // of code points, by passing the bound, and by dropping a first word longer than it.
    #[rstest]
    #[case::no_words(" \t\n", "")]
    #[case::words_joined_by_one_space("  fix   the\tlogin\nbug  ", "fix the login bug")]
    #[case::ecmascript_whitespace_splits("fix\u{FEFF}bug", "fix bug")]
    #[case::whole_words_up_to_the_bound(
        "tidy up the settings page spacing before lunch",
        "tidy up the settings page spacing before"
    )]
    #[case::code_points_not_bytes(
        "é é é é é é é é é é é é é é é é é é é é é",
        "é é é é é é é é é é é é é é é é é é é é"
    )]
    #[case::a_long_first_word_is_cut(
        "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz rest",
        "abcdefghijklmnopqrstuvwxyzabcdefghijklmn"
    )]
    fn first_words_of_takes_whole_words_up_to_forty_code_points(
        #[case] message: &str,
        #[case] expected: &str,
    ) {
        assert_eq!(first_words_of(message), expected);
    }
}
