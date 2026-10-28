//! A session names itself after its first completed exchange. One short pass of the session's own
//! provider reads the first message and the first reply and proposes a name; when it returns
//! nothing or fails, the first words of the first message are the name. The name is written
//! through the naming path only while the session is still unnamed, so a name the person typed,
//! before or during, always wins, and a rename to a name while the pass runs cancels it. A session
//! whose name the person clears is named again the same way, a pass under way finishing as that
//! naming, and the fresh name is told to its providers, since no provider takes an empty name. A
//! session left unnamed while the daemon was not following it is named at the next start, one
//! session at a time. The same name, or those first words, give a worktree's name its title.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension as _, named_params};
use serde_json::Value;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::events::SessionRenamedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::{
    NAME_SESSION_REPLY_MAX_BYTES, NameSessionParams,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::text_cut::cut_to_code_points;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::content::codec::{StoredBodyColumns, stored_body_columns_sql};
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_workspace::git::worktree::naming::DERIVED_NAME_MAX_CODE_POINTS;
use sidekicks_workspace::working_folder::{WorkingFolderReadError, read_working_folder};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::changes::SessionChanges;
use crate::run::read::read_run_provider;

/// The statements the self-naming prepares on a read connection: the first completed lead run,
/// the name and first message, the run's reply, the unnamed sessions, the session's working folder
/// and the run's provider.
pub const SESSION_AUTO_TITLE_STATEMENT_CAPACITY: usize = 6;

/// What joins one reply message to the next in the reply the pass reads.
const REPLY_MESSAGE_SEPARATOR: &str = "\n\n";

// A lead run's completion; a subagent's run reports to its parent, never to the person.
const FIRST_COMPLETED_RUN_SQL: &str = "SELECT event.run_id, event.sequence
  FROM session_events AS event JOIN runs AS run ON run.run_id = event.run_id
  WHERE event.session_id = @sessionId AND event.type = @completedType
    AND run.parent_run_id IS NULL
  ORDER BY event.sequence LIMIT 1";

const NAMING_SOURCE_SQL: &str = "SELECT name, first_message_preview FROM sessions
  WHERE id = @sessionId";

static RUN_REPLY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM session_events AS event
  WHERE event.session_id = @sessionId AND event.type = @messageType AND event.run_id = @runId
    AND event.content_payload IS NOT NULL
  ORDER BY event.sequence",
        stored_body_columns_sql("event"),
    )
});

// An unnamed session whose lead run completed an exchange, a cleared one among them. Oldest
// first: the daemon mints session ids as UUIDv7s, whose text sorts by the millisecond each session
// was made, so a backlog is named in the order it was made.
const UNNAMED_COMPLETED_SQL: &str = "SELECT session.id FROM sessions AS session
  WHERE session.name IS NULL AND session.first_message_preview IS NOT NULL
    AND EXISTS (SELECT 1 FROM session_events AS event JOIN runs AS run
                  ON run.run_id = event.run_id
                 WHERE event.session_id = session.id AND event.type = @completedType
                   AND run.parent_run_id IS NULL)
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
    /// A completion's or a clear's pass was refused while this one ran, so it names the session
    /// once more.
    is_rerun_wanted: bool,
}

/// Every pending pass by session; a session has at most one.
#[derive(Default)]
struct PendingPasses {
    next_generation: u64,
    by_session: HashMap<SessionId, PendingPass>,
}

/// Names each unnamed session after its first completed exchange, from
/// [`SessionAutoTitle::start`] until [`SessionAutoTitling::stop`].
pub struct SessionAutoTitle {
    pool: Arc<DatabaseReadPool>,
    changes: Arc<SessionChanges>,
    providers: Arc<ProviderRegistry>,
    /// Every naming task, so the stop waits for each.
    passes: TaskTracker,
    /// Canceled at the stop; each pass's token is a child of it.
    stopping: CancellationToken,
    pending: Mutex<PendingPasses>,
}

/// The follow of every session's committed events and the naming tasks, from
/// [`SessionAutoTitle::start`] until [`SessionAutoTitling::stop`].
pub struct SessionAutoTitling {
    /// Hears every committed completion and rename; dropping it detaches.
    attachment: FollowerAttachment,
    auto_title: Arc<SessionAutoTitle>,
}

impl SessionAutoTitling {
    /// Stops hearing committed events, cancels every pass under way, which then writes nothing,
    /// and settles once every naming task has ended.
    pub async fn stop(self) {
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
    pub fn new(
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
    pub fn start(self: &Arc<Self>, followers: &Arc<SessionEventFollowers>) -> SessionAutoTitling {
        let runtime = Handle::current();
        let auto_title = Arc::clone(self);
        let follower_runtime = runtime.clone();
        // Runs on the writer's pump, so it only spawns the pass or cancels it.
        let attachment = followers.follow_all(move |event| {
            let session_id = event.envelope.session_id();
            let event_type = event.envelope.event_type();
            if event_type == SessionEventType::AgentRunCompleted {
                auto_title.spawn_pass(session_id, Some(event.sequence), &follower_runtime);
            } else if event_type == SessionEventType::SessionRenamed {
                let is_cleared = serde_json::from_value::<SessionRenamedPayload>(Value::Object(
                    event.envelope.payload().clone(),
                ))
                .is_ok_and(|renamed| renamed.name.is_none());
                if is_cleared {
                    // A cleared name is named again from the first exchange, as an unnamed session
                    // is; a pass under way names it and one more runs after it, so the clear and
                    // the start's sweep cost one pass of the provider, not two.
                    auto_title.spawn_pass(session_id, None, &follower_runtime);
                } else {
                    auto_title.cancel_pass(session_id);
                }
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

    // Starts the pass after `session_id`'s completion at `completed_at`, or after its name was
    // cleared with no completion, unless one is under way.
    fn spawn_pass(
        self: &Arc<Self>,
        session_id: SessionId,
        completed_at: Option<SafeInt<0>>,
        runtime: &Handle,
    ) {
        let Some((generation, cancel)) = self.register_pass(session_id) else {
            return;
        };
        let auto_title = Arc::clone(self);
        self.passes.spawn_on(
            async move {
                auto_title
                    .name_and_release(session_id, completed_at, generation, &cancel)
                    .await;
            },
            runtime,
        );
    }

    // Runs the registered pass `generation` after the completion at `completed_at`, then once
    // more with no completion while a completion's pass was refused during the last run, and
    // forgets it.
    async fn name_and_release(
        &self,
        session_id: SessionId,
        completed_at: Option<SafeInt<0>>,
        generation: u64,
        cancel: &CancellationToken,
    ) {
        let mut completed_at = completed_at;
        loop {
            self.name_session(session_id, completed_at, cancel).await;
            if !self.release_pass(session_id, generation, cancel) {
                return;
            }
            completed_at = None;
        }
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
            self.name_and_release(session_id, None, generation, &cancel)
                .await;
        }
    }

    // Names the session from its first exchange: the pass's name, or the first message's first
    // words when the pass returns nothing. A completion at `completed_at` names it only when it is
    // the first; a canceled pass writes nothing.
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

    // One pass on the driver of the session's first completed run, which bounds the pass itself;
    // `None` when it returned nothing, failed or was canceled, or no driver answers.
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
            outcome = driver.name_session(params) => outcome,
        };
        match outcome {
            Ok(Some(name)) if !name.trim_matches(is_ecmascript_whitespace).is_empty() => Some(name),
            Ok(Some(_) | None) => None,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    session_id = session_id.text().as_str(),
                    "the session's naming pass failed; its first words name it"
                );
                None
            }
        }
    }

    // Marks a pass of `session_id` as under way, with a token canceled by a rename to a name or
    // the stop;
    // `None` when one already is, which then runs once more after its run.
    fn register_pass(&self, session_id: SessionId) -> Option<(u64, CancellationToken)> {
        let mut pending = self.lock_pending();
        if let Some(pass) = pending.by_session.get_mut(&session_id) {
            pass.is_rerun_wanted = true;
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
                is_rerun_wanted: false,
            },
        );
        Some((generation, cancel))
    }

    // Forgets the pass `generation` of `session_id` once it ended, never a later one; `true`,
    // keeping it, when a pass was refused while it ran and it was not canceled, so it runs again.
    fn release_pass(
        &self,
        session_id: SessionId,
        generation: u64,
        cancel: &CancellationToken,
    ) -> bool {
        let mut pending = self.lock_pending();
        let Some(pass) = pending
            .by_session
            .get_mut(&session_id)
            .filter(|pass| pass.generation == generation)
        else {
            return false;
        };
        if pass.is_rerun_wanted && !cancel.is_cancelled() {
            pass.is_rerun_wanted = false;
            return true;
        }
        pending.by_session.remove(&session_id);
        false
    }

    // A rename to a name landed: the session's pass under way ends and writes nothing.
    fn cancel_pass(&self, session_id: SessionId) {
        let canceled = self.lock_pending().by_session.remove(&session_id);
        if let Some(pass) = canceled {
            pass.cancel.cancel();
        }
    }

    fn lock_pending(&self) -> MutexGuard<'_, PendingPasses> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.pending)
    }
}

/// The words a session's title gives a worktree's name: its `name`, else the first words of its
/// `first_message_preview`, else those of `fallback_message`, which stands in for a first message
/// not yet recorded on the session. Empty when none gives any.
pub fn session_title_words(
    name: Option<&str>,
    first_message_preview: Option<&str>,
    fallback_message: Option<&str>,
) -> String {
    match name {
        Some(name) => name.to_owned(),
        None => first_message_preview
            .or(fallback_message)
            .map_or_else(String::new, first_words_of),
    }
}

/// Why a session's title words could not be read.
#[derive(Debug, thiserror::Error)]
pub enum SessionTitleWordsReadError {
    /// SQLite refused the read.
    #[error("a read of the session's name and first message failed")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// The words `session_id`'s title gives a worktree's name, read from its stored name and first
/// message as [`session_title_words`] reads them, `fallback_message` standing in for a first
/// message not yet recorded; `None` for a session with no row. Fails as the read fails.
pub async fn read_session_title_words(
    reads: &DatabaseReadPool,
    session_id: SessionId,
    fallback_message: Option<String>,
) -> Result<Option<String>, SessionTitleWordsReadError> {
    reads
        .read(ReadLength::Short, move |reader| {
            Ok(
                read_naming_source(reader, &session_id)?.map(|(name, first_message_preview)| {
                    session_title_words(
                        name.as_deref(),
                        first_message_preview.as_deref(),
                        fallback_message.as_deref(),
                    )
                }),
            )
        })
        .await
}

/// The fallback name a session takes from its first message: the message's whole words, split at
/// ECMAScript whitespace and joined by single spaces, up to [`DERIVED_NAME_MAX_CODE_POINTS`]; a
/// first word longer than that is cut at it. Empty when the message has no words.
pub(crate) fn first_words_of(message: &str) -> String {
    let mut words = message
        .split(is_ecmascript_whitespace)
        .filter(|word| !word.is_empty());
    let Some(first_word) = words.next() else {
        return String::new();
    };
    let mut code_points = first_word.chars().count();
    if code_points > DERIVED_NAME_MAX_CODE_POINTS {
        return cut_to_code_points(first_word, DERIVED_NAME_MAX_CODE_POINTS).to_owned();
    }
    let mut name = first_word.to_owned();
    for word in words {
        let extended = code_points + 1 + word.chars().count();
        if extended > DERIVED_NAME_MAX_CODE_POINTS {
            break;
        }
        name.push(' ');
        name.push_str(word);
        code_points = extended;
    }
    name
}

// What `session_id`'s naming reads, in one snapshot; `None` when no lead run completed, when the
// completion at `completed_at` is not the first lead run's, or the session is gone, named or has
// no first message.
fn read_naming_input(
    reader: &Connection,
    session_id: &SessionId,
    completed_at: Option<SafeInt<0>>,
) -> Result<Option<NamingInput>, NamingReadError> {
    let snapshot = reader.unchecked_transaction()?;
    let session = session_id.text();
    let completed_type = SessionEventType::AgentRunCompleted.as_str();
    let first_run = snapshot
        .prepare_cached(FIRST_COMPLETED_RUN_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session.as_str(),
                "@completedType": completed_type,
            },
            |row| {
                Ok((
                    text_column(row, 0, |text| RunId::new(&text))?,
                    row.get::<_, i64>(1)?,
                ))
            },
        )
        .optional()?;
    let Some((run_id, first_sequence)) = first_run else {
        return Ok(None);
    };
    if completed_at.is_some_and(|sequence| i64::from(sequence) != first_sequence) {
        return Ok(None);
    }
    let Some((None, Some(first_message))) = read_naming_source(&snapshot, session_id)? else {
        return Ok(None);
    };
    let place = read_working_folder(&snapshot, session_id)?.place;
    let provider = read_run_provider(&snapshot, &run_id)?.map(|run| run.provider);
    let first_reply = read_run_reply(&snapshot, session_id, &run_id)?;
    Ok(Some(NamingInput {
        first_message,
        place,
        provider,
        first_reply,
    }))
}

// `session_id`'s stored name and first message preview; `None` for a session with no row.
fn read_naming_source(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<(Option<String>, Option<String>)>> {
    reader
        .prepare_cached(NAMING_SOURCE_SQL)?
        .query_row(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
}

// The run's reply messages in order, joined, read only as far as the pass's bound and cut there
// at a character boundary. A body that does not decode fails the read, as every read of a damaged
// row does, so the session is not named from it.
fn read_run_reply(
    reader: &Connection,
    session_id: &SessionId,
    run_id: &RunId,
) -> rusqlite::Result<String> {
    let mut statement = reader.prepare_cached(&RUN_REPLY_SQL)?;
    let mut rows = statement.query(named_params! {
        "@sessionId": session_id.text().as_str(),
        "@messageType": SessionEventType::AgentMessageSent.as_str(),
        "@runId": run_id.text().as_str(),
    })?;
    let mut reply = String::new();
    while reply.len() < NAME_SESSION_REPLY_MAX_BYTES
        && let Some(row) = rows.next()?
    {
        if !reply.is_empty() {
            reply.push_str(REPLY_MESSAGE_SEPARATOR);
        }
        // Only the reply's opening is named from, so a long reply decodes only its first frames.
        let wanted = NAME_SESSION_REPLY_MAX_BYTES - reply.len().min(NAME_SESSION_REPLY_MAX_BYTES);
        if let Some(stretch) = StoredBodyColumns::read(row, 0)?.decode_stretch(0, 0, wanted)? {
            reply.push_str(&stretch.text);
        }
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
            },
            |row| text_column(row, 0, |text| SessionId::new(&text)),
        )?
        .collect()
}

#[cfg(test)]
mod tests;
