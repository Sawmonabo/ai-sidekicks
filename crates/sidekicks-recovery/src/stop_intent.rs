//! The stop intent: the record the person's Stop leaves beside the database file, so the next
//! start ends the work the Stop found in flight as the Stop ends it and resumes none of it. It is
//! whole, covering every session, or names the sessions a start has yet to settle so. One
//! `StopIntentFile` writes it, every change under one lock. A start's pass names the sessions it
//! lists, then drops each name once that session's settle has committed and before the session
//! takes runs; a drop compares the file with what the pass last read or wrote and drops nothing
//! where another write came between, so a whole file a Stop writes mid-pass stays whole. The last
//! name dropped removes the file.

use std::collections::BTreeSet;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::flush_folder;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_store::database::sibling_path;
use tokio::sync::Mutex;
use tokio::task::JoinError;

/// The suffix of the intent's file beside the database file.
pub(crate) const STOP_INTENT_SUFFIX: &str = ".stop-intent";

// The intent is the person's alone.
const STOP_INTENT_MODE: u32 = 0o600;

/// The work the person's Stop left for the next start to end as the Stop ends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopIntent {
    /// Every session's work.
    Whole,
    /// The work of these sessions alone; every other session resumes as after a crash.
    Sessions(BTreeSet<SessionId>),
}

impl StopIntent {
    /// Whether this intent covers `session_id`: a whole one covers every session.
    pub fn names(&self, session_id: &SessionId) -> bool {
        match self {
            Self::Whole => true,
            Self::Sessions(sessions) => sessions.contains(session_id),
        }
    }
}

/// Why the stop intent could not be written or removed; what the file held before stays.
#[derive(Debug, thiserror::Error)]
pub enum StopIntentError {
    /// The intent could not be written.
    #[error("the stop intent could not be written")]
    Write(#[source] AtomicWriteError),
    /// The file system refused the intent's removal or the flush of its folder.
    #[error("the stop intent could not be removed, or its folder flushed")]
    Remove(#[source] io::Error),
    /// The blocking task that flushed the intent's folder ended first.
    #[error("the flush of the stop intent's folder ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// The stop intent's one file beside the database file, every read-modify-write of it taken under
/// one lock.
pub struct StopIntentFile {
    path: PathBuf,
    lock: Mutex<()>,
}

impl StopIntentFile {
    /// The intent kept beside the database file at `database_path`, whose folder holds it.
    pub fn new(database_path: &Path) -> Self {
        Self {
            path: sibling_path(database_path, STOP_INTENT_SUFFIX),
            lock: Mutex::new(()),
        }
    }

    /// Where the intent's file lives.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The intent as the file holds it: `None` where there is none, and whole, logged, where the
    /// file cannot be read or is not an intent, since only a Stop writes one.
    pub async fn read(&self) -> Option<StopIntent> {
        let held = match tokio::fs::read(&self.path).await.none_if_missing() {
            Ok(held) => held?,
            Err(failure) => {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "the stop intent could not be read; the start ends every session's work as \
                     the Stop does"
                );
                return Some(StopIntent::Whole);
            }
        };
        match serde_json::from_slice(&held) {
            Ok(intent) => Some(intent),
            Err(failure) => {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "the stop intent is not one the service wrote; the start ends every \
                     session's work as the Stop does"
                );
                Some(StopIntent::Whole)
            }
        }
    }

    /// Writes the intent whole, for the person's Stop and a restore. Fails when the write fails,
    /// the file then holding what it held.
    pub async fn write_whole(&self) -> Result<(), StopIntentError> {
        let _held = self.lock.lock().await;
        self.write(&StopIntent::Whole).await
    }

    /// Where the file still holds `read` and that is whole, rewrites it as the names of
    /// `sessions`, removing it where there are none; any other file is left as it is. Answers what
    /// the caller then holds as last read or written: what this wrote, or `read` where it wrote
    /// nothing. Fails when the write or the removal fails, the file then holding what it held.
    pub async fn name_sessions(
        &self,
        read: &StopIntent,
        sessions: BTreeSet<SessionId>,
    ) -> Result<Option<StopIntent>, StopIntentError> {
        let _held = self.lock.lock().await;
        if *read != StopIntent::Whole || self.read().await.as_ref() != Some(read) {
            return Ok(Some(read.clone()));
        }
        self.replace(sessions).await
    }

    /// Drops `session_id` from the names, for the pass once that session's settle has committed,
    /// only where the file still holds `read`, what the caller last read or wrote, and that names
    /// it; a file written since, a whole one a Stop wrote among them, keeps every name. The last
    /// name dropped removes the file. Answers what the caller then holds as last read or written,
    /// as [`StopIntentFile::name_sessions`] does. Fails when the write or the removal fails.
    pub async fn drop_session(
        &self,
        read: &StopIntent,
        session_id: &SessionId,
    ) -> Result<Option<StopIntent>, StopIntentError> {
        let _held = self.lock.lock().await;
        let StopIntent::Sessions(sessions) = read else {
            return Ok(Some(read.clone()));
        };
        if !sessions.contains(session_id) || self.read().await.as_ref() != Some(read) {
            return Ok(Some(read.clone()));
        }
        let mut remaining = sessions.clone();
        remaining.remove(session_id);
        self.replace(remaining).await
    }

    /// Drops `session_id` from a file of names, for a caller that holds no read of the file, a
    /// purge or `Continue from here`; a whole file, or none, is left as it is. The last name
    /// dropped removes the file. Fails when the write or the removal fails.
    pub async fn drop_named(&self, session_id: &SessionId) -> Result<(), StopIntentError> {
        let _held = self.lock.lock().await;
        let Some(StopIntent::Sessions(mut sessions)) = self.read().await else {
            return Ok(());
        };
        if !sessions.remove(session_id) {
            return Ok(());
        }
        self.replace(sessions).await.map(|_written| ())
    }

    // Writes `sessions` as the file's names, or removes it where there are none, under the lock
    // the caller holds; answers what the file then holds.
    async fn replace(
        &self,
        sessions: BTreeSet<SessionId>,
    ) -> Result<Option<StopIntent>, StopIntentError> {
        if sessions.is_empty() {
            self.remove().await?;
            return Ok(None);
        }
        let intent = StopIntent::Sessions(sessions);
        self.write(&intent).await?;
        Ok(Some(intent))
    }

    // Writes `intent` durably at once, under the lock the caller holds.
    async fn write(&self, intent: &StopIntent) -> Result<(), StopIntentError> {
        let contents = serde_json::to_vec(intent).expect("an intent of ids serializes");
        write_file_atomically(&self.path, contents, STOP_INTENT_MODE)
            .await
            .map_err(StopIntentError::Write)
    }

    // Removes the file and flushes its folder, so the removal survives a power loss; a file
    // already gone is removed.
    async fn remove(&self) -> Result<(), StopIntentError> {
        tokio::fs::remove_file(&self.path)
            .await
            .none_if_missing()
            .map_err(StopIntentError::Remove)?;
        let folder = self
            .path
            .parent()
            .expect("the stop intent's path names its folder")
            .to_path_buf();
        tokio::task::spawn_blocking(move || flush_folder(&folder))
            .await
            .map_err(StopIntentError::Interrupted)?
            .map_err(StopIntentError::Remove)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use rstest::rstest;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    use super::{StopIntent, StopIntentFile};

    // What happens to the file between the pass's read and its drop.
    #[derive(Clone, Copy, Debug)]
    enum Between {
        // Nothing: the pass drops one name of two.
        Nothing,
        // Nothing, and the pass drops the last name.
        NothingLastName,
        // The person's Stop writes the file whole.
        StopWritesWhole,
        // The file is overwritten with what no service wrote.
        Unreadable,
        // A purge drops a name from a whole file.
        DropNamedOnWhole,
    }

    fn session_id() -> SessionId {
        SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is an id")
    }

    #[rstest]
    #[case::a_drop_after_a_read(Between::Nothing)]
    #[case::the_last_drop(Between::NothingLastName)]
    #[case::a_whole_file_written_since_the_read(Between::StopWritesWhole)]
    #[case::an_unreadable_file(Between::Unreadable)]
    #[case::drop_named_on_a_whole_file(Between::DropNamedOnWhole)]
    #[tokio::test]
    async fn a_stop_intent_drops_a_name_only_against_what_it_read(#[case] between: Between) {
        let folder = tempfile::tempdir().expect("a temporary folder");
        let database_path = folder.path().join("daemon.db");
        let file = StopIntentFile::new(&database_path);
        let (first, second) = (session_id(), session_id());
        file.write_whole()
            .await
            .expect("the Stop writes the intent");
        let read = file.read().await.expect("a written intent reads");
        assert_eq!(read, StopIntent::Whole);
        let named = match between {
            Between::NothingLastName => BTreeSet::from([first]),
            Between::Nothing
            | Between::StopWritesWhole
            | Between::Unreadable
            | Between::DropNamedOnWhole => BTreeSet::from([first, second]),
        };
        let held = file
            .name_sessions(&read, named.clone())
            .await
            .expect("the pass names its sessions")
            .expect("named sessions keep the file");
        assert_eq!(held, StopIntent::Sessions(named));
        match between {
            Between::Nothing | Between::NothingLastName => {}
            Between::StopWritesWhole => file.write_whole().await.expect("the Stop writes"),
            Between::Unreadable => {
                tokio::fs::write(&file.path, b"not an intent")
                    .await
                    .expect("the file is overwritten");
                assert_eq!(file.read().await, Some(StopIntent::Whole));
            }
            Between::DropNamedOnWhole => {
                file.write_whole().await.expect("the Stop writes");
                file.drop_named(&first).await.expect("the purge drops");
                assert_eq!(file.read().await, Some(StopIntent::Whole));
            }
        }
        let after = file
            .drop_session(&held, &first)
            .await
            .expect("the drop answers");
        let on_disk = file.read().await;
        match between {
            Between::Nothing => {
                let left = Some(StopIntent::Sessions(BTreeSet::from([second])));
                assert_eq!(after, left);
                assert_eq!(on_disk, left);
            }
            Between::NothingLastName => {
                assert_eq!(after, None);
                assert!(
                    !tokio::fs::try_exists(&file.path)
                        .await
                        .expect("the folder reads"),
                    "the last drop removes the file"
                );
            }
            Between::StopWritesWhole | Between::Unreadable | Between::DropNamedOnWhole => {
                assert_eq!(after, Some(held));
                assert_eq!(on_disk, Some(StopIntent::Whole));
            }
        }
    }
}
