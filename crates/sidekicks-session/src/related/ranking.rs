//! Each session's related list, its linked sessions scored ahead and stored under its id so a read
//! is one indexed lookup. A link change re-scores, on a task of its own after its write commits,
//! the two sessions it joins and their neighbors: no other session's two-step walk crosses a
//! changed share. A round reads and scores its sessions in one read on the blocking pool, so it
//! never holds the runtime's workers. A follower of a session's list holds a count raised whenever
//! the list may read differently and reads the newest list then. A rename raises the counts of the
//! lists that show the renamed session, since an entry reads its name from the session's row.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::FutureExt;
use rusqlite::types::Value;
use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::links::{
    SessionLinkKind, SessionRelatedListEntry, SessionRelatedListUpdate,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::retry::waits::retry_wait;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_store::events::session::pending::PendingSessions;
use tokio::sync::watch;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::directory::lookups::session_exists;
use crate::related::score::{
    SessionLinkEnd, score_related_sessions, session_link_kind_weight, session_link_weight,
};

/// The statements the ranking's reads prepare: a session's links, its stored list and whether the
/// session exists.
pub const RELATED_RANKING_STATEMENT_CAPACITY: usize = 3;

// The most sessions one round scores and one stored write replaces, so a burst of link changes
// never makes one long read or one huge write; the rest wait for the next round.
const RESCORE_ROUND_LIMIT: usize = 64;

const LINKS_OF_SESSION_SQL: &str = "
  SELECT target_session_id, kind, 1 AS is_source, use_count, last_at
    FROM session_links WHERE source_session_id = @sessionId
  UNION ALL
  SELECT source_session_id, kind, 0 AS is_source, use_count, last_at
    FROM session_links WHERE target_session_id = @sessionId";

const STORED_RELATED_SQL: &str = "
  SELECT related.related_session_id, session.name
    FROM session_related AS related
    JOIN sessions AS session ON session.id = related.related_session_id
   WHERE related.session_id = ?
   ORDER BY related.score DESC, related.related_session_id";

const DELETE_RELATED_SQL: &str = "DELETE FROM session_related WHERE session_id = ?";

// A session purged while its round was scored is gone from `sessions` by the time the round's
// write runs, so the write stores no list for it and no entry naming it, and the purge leaves no
// row behind.
const REPLACE_RELATED_SQL: &str = "
  INSERT INTO session_related (session_id, related_session_id, score)
  SELECT @sessionId, scored.value ->> '$[0]', scored.value ->> '$[1]'
    FROM json_each(@scores) AS scored
    JOIN sessions AS related ON related.id = scored.value ->> '$[0]'
   WHERE EXISTS (SELECT 1 FROM sessions WHERE id = @sessionId)";

/// Why a session's related list could not be read.
#[derive(Debug, thiserror::Error)]
pub enum SessionRelatedReadError {
    /// The session is not one this daemon holds (`session.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("a read of a session's related list failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl SessionRelatedReadError {
    /// Whether the read failed because the read pool is closed, as it is at the daemon's stop.
    pub fn is_pool_closed(&self) -> bool {
        match self {
            Self::Pool(DatabaseReadError::Closed) => true,
            Self::Pool(DatabaseReadError::Open(_) | DatabaseReadError::Join(_))
            | Self::Refused(_)
            | Self::Database(_) => false,
        }
    }
}

impl From<SessionRelatedReadError> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`; a failed read is a fault in
    /// the daemon.
    fn from(error: SessionRelatedReadError) -> Self {
        match error {
            SessionRelatedReadError::Refused(refusal) => Self::Refused(refusal),
            fault @ (SessionRelatedReadError::Database(_) | SessionRelatedReadError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

// Why a re-score round, or the read of the lists that show a renamed session, failed.
#[derive(Debug, thiserror::Error)]
enum RescoringError {
    #[error("a read of session links failed")]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    #[error("the round's related lists were not stored")]
    Write(#[from] WriteError),
}

/// Scores, stores and serves each session's related list. Re-scoring runs one round at a time on
/// the task [`SessionRelatedRanking::start`] spawns, so a link verb never waits on it, and a
/// session asked for twice before its round is scored once. Shared by `Arc`.
pub struct SessionRelatedRanking {
    /// The pool every read borrows a connection from.
    reads: Arc<DatabaseReadPool>,
    /// Where each round's lists are stored.
    writer: Arc<DatabaseWriter>,
    /// Sessions whose links changed since the task last took them.
    changed: PendingSessions,
    /// Renamed sessions whose showing lists the task has yet to raise.
    renamed: PendingSessions,
    // Only sessions someone followed at the last `follow` or raise have an entry.
    followed: Mutex<HashMap<SessionId, watch::Sender<u64>>>,
}

/// The re-scoring task and its follower of renames, from [`SessionRelatedRanking::start`] until
/// [`RelatedRescoring::stop`].
pub struct RelatedRescoring {
    /// Hears every committed rename; dropping it detaches.
    attachment: FollowerAttachment,
    /// Ends the task after the round under way, and a retry still waiting.
    stop: CancellationToken,
    /// The task that scores the rounds.
    task: JoinHandle<()>,
}

impl RelatedRescoring {
    /// Stops hearing renames, ends re-scoring after the round under way, drops a retry still
    /// waiting, and settles once that round's write and raises are done. Fails only when the task
    /// itself ended abnormally.
    pub async fn stop(self) -> Result<(), JoinError> {
        let Self {
            attachment,
            stop,
            task,
        } = self;
        drop(attachment);
        stop.cancel();
        task.await
    }
}

impl SessionRelatedRanking {
    /// A ranking reading through `reads` and storing through `writer`; nothing is re-scored until
    /// [`SessionRelatedRanking::start`].
    pub fn new(reads: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self {
            reads,
            writer,
            changed: PendingSessions::default(),
            renamed: PendingSessions::default(),
            followed: Mutex::new(HashMap::new()),
        }
    }

    /// Follows every committed rename of `followers` and starts the re-scoring task, both until
    /// the returned handle's stop.
    pub fn start(self: &Arc<Self>, followers: &Arc<SessionEventFollowers>) -> RelatedRescoring {
        let ranking = Arc::clone(self);
        // Runs on the writer's pump, so it only names the session for the task.
        let attachment = followers.follow_all(move |event| {
            if event.envelope.event_type() == SessionEventType::SessionRenamed {
                ranking.renamed.add(event.envelope.session_id());
            }
            Ok(())
        });
        let stop = CancellationToken::new();
        let task = tokio::spawn(rescore_until_stopped(Arc::clone(self), stop.clone()));
        RelatedRescoring {
            attachment,
            stop,
            task,
        }
    }

    /// Queues the sessions a committed link change joined for re-scoring, with their neighbors,
    /// and returns at once.
    pub fn rescore_around(&self, session_ids: impl IntoIterator<Item = SessionId>) {
        for session_id in session_ids {
            self.changed.add(session_id);
        }
    }

    /// The session's related sessions, most relevant first, each with the strongest link the pair
    /// shares. Fails with `session.notFound` for a session the daemon has no record of, and as the
    /// read fails.
    pub async fn read(
        &self,
        session_id: SessionId,
    ) -> Result<SessionRelatedListUpdate, SessionRelatedReadError> {
        self.reads
            .read(
                ReadLength::Short,
                move |connection| -> Result<SessionRelatedListUpdate, SessionRelatedReadError> {
                    let snapshot = connection.unchecked_transaction()?;
                    if !session_exists(&snapshot, &session_id)? {
                        return Err(session_not_found(&session_id).into());
                    }
                    let update = read_stored(&snapshot, session_id, jiff::Timestamp::now())?;
                    snapshot.commit()?;
                    Ok(update)
                },
            )
            .await
    }

    /// The count of `session_id`'s list, raised each time the list may read differently: after a
    /// re-score of it stores, and after a session it shows is renamed. The follower reads the
    /// newest list with [`SessionRelatedRanking::read`] after subscribing and whenever the count
    /// moves. Each call first drops every count no receiver reads any more.
    pub fn follow(&self, session_id: &SessionId) -> watch::Receiver<u64> {
        let mut followed = self.lock_followed();
        followed.retain(|_, count| count.receiver_count() > 0);
        followed
            .entry(*session_id)
            .or_insert_with(|| watch::Sender::new(0))
            .subscribe()
    }

    /// How many followers still read a count, across every session.
    #[cfg(any(test, feature = "test-support"))]
    pub fn open_follow_count(&self) -> usize {
        self.lock_followed()
            .values()
            .map(watch::Sender::receiver_count)
            .sum()
    }

    // Scores one round: the changed sessions join the queue, and their neighbors, read in the
    // round's own read, join it for the next round. A failure leaves every session queued.
    async fn rescore_round(&self, queue: &mut RescoreQueue) -> Result<(), RescoringError> {
        let changed: Vec<SessionId> = queue.changed.iter().copied().collect();
        queue.to_score.push_all(changed.iter().copied());
        let round = queue.to_score.take_round();
        let scored_round = round.clone();
        let scored = self
            .reads
            .read(ReadLength::Long, move |connection| {
                Ok::<_, RescoringError>(score_round(
                    connection,
                    &changed,
                    &scored_round,
                    jiff::Timestamp::now(),
                )?)
            })
            .await;
        let scored = match scored {
            Ok(scored) => scored,
            Err(error) => {
                queue.to_score.push_all(round);
                return Err(error);
            }
        };
        queue.changed.clear();
        queue.to_score.push_all(
            scored
                .neighbors
                .into_iter()
                .filter(|neighbor| !round.contains(neighbor)),
        );
        if let Err(error) = self.writer.write(scored.statements).await {
            queue.to_score.push_all(round);
            return Err(error.into());
        }
        self.raise_counts(&round);
        Ok(())
    }

    // Each followed list that shows a renamed session is the list of a session linked to it. A
    // failed read is logged, leaves the renamed sessions waiting for the retry and fails with its
    // cause.
    async fn raise_lists_showing(&self, renamed: HashSet<SessionId>) -> Result<(), RescoringError> {
        if !self.is_any_followed() {
            return Ok(());
        }
        let reading = renamed.clone();
        let linked = self
            .reads
            .read(ReadLength::Short, move |connection| {
                let mut linked = HashSet::new();
                for session_id in &reading {
                    for link in link_ends_of(connection, session_id)? {
                        linked.insert(link.other_session_id);
                    }
                }
                Ok::<_, RescoringError>(linked)
            })
            .await;
        match linked {
            Ok(linked) => {
                self.raise_counts(&linked);
                Ok(())
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "related_sessions_rename_raise_failed"
                );
                for session_id in renamed {
                    self.renamed.add(session_id);
                }
                Err(error)
            }
        }
    }

    // Raises the lists showing the renames waiting, then scores a round, whether or not the raise
    // failed; answers each step's result, each failure logged and its sessions kept waiting.
    async fn raise_and_rescore(
        &self,
        queue: &mut RescoreQueue,
    ) -> (Result<(), RescoringError>, Result<(), RescoringError>) {
        let raised = match self.renamed.take().now_or_never() {
            Some(renamed) => self.raise_lists_showing(renamed).await,
            None => Ok(()),
        };
        let rescored = self.rescore_round(queue).await;
        if let Err(error) = &rescored {
            tracing::warn!(
                error = error as &(dyn Error + 'static),
                "related_sessions_rescore_failed"
            );
        }
        (raised, rescored)
    }

    fn raise_counts<'ids>(&self, session_ids: impl IntoIterator<Item = &'ids SessionId>) {
        let mut followed = self.lock_followed();
        followed.retain(|_, count| count.receiver_count() > 0);
        for session_id in session_ids {
            if let Some(count) = followed.get(session_id) {
                count.send_modify(|raised| *raised += 1);
            }
        }
    }

    fn is_any_followed(&self) -> bool {
        let mut followed = self.lock_followed();
        followed.retain(|_, count| count.receiver_count() > 0);
        !followed.is_empty()
    }

    // Waits out `wait` before a retry, raising renamed lists meanwhile unless the raise has failed;
    // a link change retries at once. A failed raise leaves its renames for the retry, so none is
    // taken again before it. False once stopped.
    async fn wait_to_retry(
        &self,
        wait: Duration,
        is_raise_failed: bool,
        queue: &mut RescoreQueue,
        stop: &CancellationToken,
    ) -> bool {
        let retry_at = tokio::time::Instant::now() + wait;
        let mut is_raising = !is_raise_failed;
        loop {
            tokio::select! {
                biased;
                () = stop.cancelled() => return false,
                () = tokio::time::sleep_until(retry_at) => return true,
                changed = self.changed.take() => {
                    queue.changed.extend(changed);
                    return true;
                }
                renamed = self.renamed.take(), if is_raising => {
                    is_raising = self.raise_lists_showing(renamed).await.is_ok();
                }
            }
        }
    }

    fn lock_followed(&self) -> MutexGuard<'_, HashMap<SessionId, watch::Sender<u64>>> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.followed)
    }
}

// No caller waits on a round or on the raise a rename asks for, so a failed one, logged where it
// failed, is retried after the daemon's retry waits, its sessions kept waiting, or sooner with the
// next link change.
async fn rescore_until_stopped(ranking: Arc<SessionRelatedRanking>, stop: CancellationToken) {
    let mut queue = RescoreQueue::default();
    let mut failed_rounds_in_row = 0;
    loop {
        let (raised, rescored) = if queue.is_empty() {
            tokio::select! {
                biased;
                () = stop.cancelled() => return,
                changed = ranking.changed.take() => {
                    queue.changed.extend(changed);
                    continue;
                }
                renamed = ranking.renamed.take() => {
                    (ranking.raise_lists_showing(renamed).await, Ok(()))
                }
            }
        } else {
            if let Some(changed) = ranking.changed.take().now_or_never() {
                queue.changed.extend(changed);
            }
            ranking.raise_and_rescore(&mut queue).await
        };
        if raised.is_ok() && rescored.is_ok() {
            failed_rounds_in_row = 0;
        } else {
            let wait = retry_wait(failed_rounds_in_row);
            failed_rounds_in_row += 1;
            if !ranking
                .wait_to_retry(wait, raised.is_err(), &mut queue, &stop)
                .await
            {
                return;
            }
        }
        if stop.is_cancelled() {
            return;
        }
    }
}

// What the task holds between rounds.
#[derive(Default)]
struct RescoreQueue {
    // Sessions whose links changed; the next round reads their neighbors and queues them.
    changed: HashSet<SessionId>,
    // Sessions waiting to be scored.
    to_score: ScoringQueue,
}

impl RescoreQueue {
    fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.to_score.is_empty()
    }
}

// Sessions waiting to be scored, each once, in the order queued, so a burst of new ones never
// keeps an older one waiting.
#[derive(Default)]
struct ScoringQueue {
    order: VecDeque<SessionId>,
    queued: HashSet<SessionId>,
}

impl ScoringQueue {
    fn push_all(&mut self, session_ids: impl IntoIterator<Item = SessionId>) {
        for session_id in session_ids {
            if self.queued.insert(session_id) {
                self.order.push_back(session_id);
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    // The next round: the longest-waiting sessions, at most a round's limit.
    fn take_round(&mut self) -> Vec<SessionId> {
        let round_length = self.order.len().min(RESCORE_ROUND_LIMIT);
        let round: Vec<SessionId> = self.order.drain(..round_length).collect();
        for session_id in &round {
            self.queued.remove(session_id);
        }
        round
    }
}

// A scored round: the statements that store its lists, and the changed sessions' neighbors.
struct ScoredRound {
    statements: Vec<WriteStatement>,
    neighbors: Vec<SessionId>,
}

// Reads the changed sessions' neighbors and scores the round in one read transaction, each
// session's walk reading its links and its neighbors' once.
fn score_round(
    connection: &Connection,
    changed: &[SessionId],
    round: &[SessionId],
    now: jiff::Timestamp,
) -> rusqlite::Result<ScoredRound> {
    let snapshot = connection.unchecked_transaction()?;
    let mut neighbors = Vec::new();
    for session_id in changed {
        neighbors.extend(
            link_ends_of(&snapshot, session_id)?
                .into_iter()
                .map(|link| link.other_session_id),
        );
    }
    let mut links_by_session: HashMap<SessionId, Vec<SessionLinkEnd>> = HashMap::new();
    let mut statements = Vec::with_capacity(round.len() * 2);
    for session_id in round {
        let neighbor_ids: Vec<SessionId> =
            cached_link_ends(&snapshot, &mut links_by_session, *session_id)?
                .iter()
                .map(|link| link.other_session_id)
                .collect();
        for neighbor_id in neighbor_ids {
            cached_link_ends(&snapshot, &mut links_by_session, neighbor_id)?;
        }
        let links = &links_by_session;
        let scores = score_related_sessions(
            session_id,
            |scored_id| links.get(scored_id).map_or(&[][..], Vec::as_slice),
            now,
        );
        statements.extend(replace_related_statements(session_id, &scores));
    }
    snapshot.commit()?;
    Ok(ScoredRound {
        statements,
        neighbors,
    })
}

fn cached_link_ends<'cache>(
    connection: &Connection,
    cache: &'cache mut HashMap<SessionId, Vec<SessionLinkEnd>>,
    session_id: SessionId,
) -> rusqlite::Result<&'cache [SessionLinkEnd]> {
    match cache.entry(session_id) {
        Entry::Occupied(cached) => Ok(cached.into_mut().as_slice()),
        Entry::Vacant(missing) => Ok(missing
            .insert(link_ends_of(connection, &session_id)?)
            .as_slice()),
    }
}

// The two statements that replace `session_id`'s stored list with `scores`.
fn replace_related_statements(
    session_id: &SessionId,
    scores: &[(SessionId, f64)],
) -> [WriteStatement; 2] {
    let session_text = session_id.text();
    let scores = serde_json::to_string(scores).expect("ids and finite numbers always serialize");
    [
        WriteStatement {
            sql: Cow::Borrowed(DELETE_RELATED_SQL),
            bindings: StatementBindings::Positional(vec![Value::Text(
                session_text.as_str().to_owned(),
            )]),
            expected_row_count: None,
        },
        WriteStatement {
            sql: Cow::Borrowed(REPLACE_RELATED_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@sessionId", session_text.as_str()),
                text_binding("@scores", &scores),
            ]),
            expected_row_count: None,
        },
    ]
}

// A session purged since it was followed reads as an empty list.
fn read_stored(
    connection: &Connection,
    session_id: SessionId,
    now: jiff::Timestamp,
) -> rusqlite::Result<SessionRelatedListUpdate> {
    let strongest_links = strongest_links_of(link_ends_of(connection, &session_id)?, now);
    let session_text = session_id.text();
    let mut statement = connection.prepare_cached(STORED_RELATED_SQL)?;
    let stored = statement.query_map([session_text.as_str()], |row| {
        Ok((
            text_column(row, 0, |text| SessionId::new(&text))?,
            optional_text_column(row, 1, FreeFormText::new)?,
        ))
    })?;
    let mut related = Vec::new();
    // A link removed since the last re-score keeps its stored row until the next one, and the list
    // names linked sessions only.
    for row in stored {
        let (related_session_id, name) = row?;
        let Some(pair) = strongest_links.get(&related_session_id) else {
            continue;
        };
        let strongest = &pair.strongest;
        related.push(SessionRelatedListEntry {
            session_id: related_session_id,
            name,
            kind: strongest.kind,
            session_is_source: strongest.is_source,
            message_count: if strongest.kind == SessionLinkKind::Messaged {
                SafeInt::new(u64::from(strongest.use_count))
            } else {
                None
            },
            removable: pair.is_removable,
        });
    }
    Ok(SessionRelatedListUpdate {
        session_id,
        related,
    })
}

fn link_ends_of(
    connection: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<SessionLinkEnd>> {
    let mut statement = connection.prepare_cached(LINKS_OF_SESSION_SQL)?;
    let links = statement.query_map(
        named_params! { "@sessionId": session_id.text().as_str() },
        link_end_of,
    )?;
    links.collect()
}

fn link_end_of(row: &Row<'_>) -> rusqlite::Result<SessionLinkEnd> {
    Ok(SessionLinkEnd {
        other_session_id: text_column(row, 0, |text| SessionId::new(&text))?,
        kind: text_column(row, 1, closed_word::<SessionLinkKind>)?,
        is_source: row.get(2)?,
        use_count: row.get(3)?,
        last_at: text_column(row, 4, |text| text.parse::<jiff::Timestamp>())?,
    })
}

// A linked session's strongest link with the followed one now, and whether the pair carries a
// `related` link.
struct StrongestLink {
    strongest: SessionLinkEnd,
    weight: f64,
    is_removable: bool,
}

fn strongest_links_of(
    links: Vec<SessionLinkEnd>,
    now: jiff::Timestamp,
) -> HashMap<SessionId, StrongestLink> {
    let mut by_pair: HashMap<SessionId, StrongestLink> = HashMap::new();
    for link in links {
        let weight = session_link_weight(&link, now);
        let is_related = link.kind == SessionLinkKind::Related;
        match by_pair.entry(link.other_session_id) {
            Entry::Vacant(missing) => {
                missing.insert(StrongestLink {
                    strongest: link,
                    weight,
                    is_removable: is_related,
                });
            }
            Entry::Occupied(mut held) => {
                let held = held.get_mut();
                held.is_removable |= is_related;
                if is_stronger(&link, weight, &held.strongest, held.weight) {
                    held.strongest = link;
                    held.weight = weight;
                }
            }
        }
    }
    by_pair
}

// The heavier link wins; at equal weight the kind with the higher base weight does.
fn is_stronger(
    link: &SessionLinkEnd,
    weight: f64,
    held: &SessionLinkEnd,
    held_weight: f64,
) -> bool {
    match weight.total_cmp(&held_weight) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => {
            session_link_kind_weight(link.kind) > session_link_kind_weight(held.kind)
        }
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_store::database::writer::test_file::test_session_id;

    use super::{RESCORE_ROUND_LIMIT, ScoringQueue};

    #[test]
    fn a_round_takes_at_most_its_limit_and_the_rest_wait_for_the_next() {
        let queued: Vec<SessionId> = (0..RESCORE_ROUND_LIMIT + 6)
            .map(|_| test_session_id())
            .collect();
        let mut queue = ScoringQueue::default();
        queue.push_all(queued.iter().copied());

        assert_eq!(queue.take_round(), queued[..RESCORE_ROUND_LIMIT].to_vec());
        assert!(!queue.is_empty(), "the sessions past the limit wait");
        assert_eq!(queue.take_round(), queued[RESCORE_ROUND_LIMIT..].to_vec());
        assert!(queue.is_empty());
    }
}
