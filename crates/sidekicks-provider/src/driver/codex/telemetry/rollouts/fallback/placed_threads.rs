//! The rollout file of an off-stream thread an export's response was just placed on, read on as
//! it is placed: a hosted web search inside that request reaches no export, so its file's search
//! line is what charges it while the export arrives. The read hands every charge the file states
//! from the launch's registration on, each passed over where its stream or export priced it, so
//! the file's offset moves past nothing a later stop would still have to read. A file the two day
//! folders around the response miss is looked up once by its thread through Codex's `thread/read`.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_std::mutex_lock::lock;
use sidekicks_std::unix_time::read_unix_time_ms;

use super::sessions_folder::{SESSIONS_FOLDER, find_thread_rollout, is_rollout_of};
use super::{
    CodexFollowedRollout, CodexRolloutFallback, CodexRolloutPlacement, CodexRolloutTarget,
    read_followed,
};
use crate::bounded_queue::remember;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::telemetry::placement::CodexOffStreamThread;
use crate::driver::codex::telemetry::rollouts::file::CodexRolloutFile;
use crate::driver::codex::thread::view::{CodexThreadFile, request_thread_file};

/// How many placed threads Codex names no rollout file for one launch remembers, so the next
/// response placed on an ephemeral thread looks for none again; past it the oldest is forgotten.
const FILELESS_KEPT: usize = 64;

/// A day, in seconds: a thread may have been made the day before its response.
const DAY_S: i64 = 86_400;

impl CodexRolloutFallback {
    /// Reads on the rollout file of `placed`'s thread, a thread no session streams that an
    /// export's response was just placed on, handing each charge it states since the launch
    /// registered to the session the response went to, at its placement; the file is then kept
    /// among the files let go. A file a stop's reading follows is left to that reading's passes,
    /// which the export named it to; a file neither day folder holds is looked up by its thread,
    /// and a thread Codex names no file for is not looked for again.
    pub(crate) async fn read_placed(
        &mut self,
        service: &Arc<CodexService>,
        placed: CodexOffStreamThread,
    ) {
        let thread_id = placed.thread_id;
        if self.fileless.contains(&thread_id)
            || self
                .files
                .keys()
                .any(|path| is_rollout_of(path, &thread_id))
        {
            return;
        }
        let kept = self
            .let_go
            .iter()
            .position(|(path, _followed)| is_rollout_of(path, &thread_id));
        let (path, mut followed) = if let Some(index) = kept {
            self.let_go
                .remove(index)
                .expect("the position is in the queue")
        } else {
            let sessions = service.home().codex_home.join(SESSIONS_FOLDER);
            let at_ms = match placed.observed_at_ms {
                0 => read_unix_time_ms(),
                observed_at_ms => observed_at_ms,
            };
            let made_at_s = i64::try_from(at_ms / 1_000).unwrap_or(i64::MAX);
            let find_thread = thread_id.clone();
            let found = tokio::task::spawn_blocking(move || {
                find_thread_rollout(
                    &sessions,
                    &find_thread,
                    &[made_at_s, made_at_s.saturating_sub(DAY_S)],
                )
            })
            .await;
            let found = match found {
                Ok(Some(found)) => Some(found),
                Ok(None) => self.look_up_file(service, &thread_id).await,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        conversation_id = thread_id.as_str(),
                        "a placed codex thread's rollout file could not be looked for"
                    );
                    return;
                }
            };
            let Some((path, size)) = found else {
                return;
            };
            (
                path,
                CodexFollowedRollout {
                    file: CodexRolloutFile::default(),
                    offset: 0,
                    size,
                    placement: CodexRolloutPlacement::Unplaced { walks: 0 },
                    is_read_failed: false,
                },
            )
        };
        let since_ms = lock(&self.rollouts.times).registered_at_ms;
        let target = CodexRolloutTarget {
            session_id: placed.session_id,
            placed: Some(placed.placed),
        };
        // A read that learns the file's thread stops just past the line naming it; one more reads
        // on to the end.
        loop {
            let is_thread_unknown = followed.file.thread().is_none();
            let is_read = read_followed(
                service,
                &path,
                &mut followed,
                since_ms,
                Some(target.clone()),
            )
            .await;
            if !(is_read && is_thread_unknown && followed.file.thread().is_some()) {
                break;
            }
        }
        self.let_go_of(path, followed);
    }

    // The rollout file of `thread_id` where Codex's `thread/read` names one, with its size; a
    // thread it names no file for is remembered as fileless, and a lookup that fails, or a file
    // not written yet, is logged and left to the thread's next placement.
    async fn look_up_file(
        &mut self,
        service: &CodexService,
        thread_id: &str,
    ) -> Option<(PathBuf, u64)> {
        let looked_up = match service.connection() {
            Ok(connection) => request_thread_file(&connection, thread_id).await,
            Err(error) => Err(error),
        };
        let failure: Box<dyn std::error::Error + Send + Sync> = match looked_up {
            Ok(CodexThreadFile::At(path)) => match tokio::fs::metadata(&path).await {
                Ok(metadata) => return Some((path, metadata.len())),
                Err(error) => Box::new(error),
            },
            Ok(CodexThreadFile::Never) => {
                remember(&mut self.fileless, thread_id.to_owned(), FILELESS_KEPT);
                return None;
            }
            Err(error) => Box::new(error),
        };
        tracing::warn!(
            error = &*failure as &(dyn std::error::Error + 'static),
            conversation_id = thread_id,
            "a placed codex thread's rollout file could not be looked up"
        );
        None
    }
}
