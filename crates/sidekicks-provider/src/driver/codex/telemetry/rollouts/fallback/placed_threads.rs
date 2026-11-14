//! The rollout file of an off-stream thread an export's response was just placed on, read on as
//! it is placed: a hosted web search inside that request reaches no export, so its file's search
//! line is what charges it while the export arrives. The read hands every charge the file states
//! from the launch's registration on, each passed over where its stream or export priced it, so
//! the file's offset moves past nothing a later stop would still have to read.

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

/// How many placed threads found with no rollout file one launch remembers, so the next response
/// placed on an ephemeral thread lists no day folder again; past it the oldest is forgotten.
const FILELESS_KEPT: usize = 64;

/// A day, in seconds: a thread may have been made the day before its response.
const DAY_S: i64 = 86_400;

impl CodexRolloutFallback {
    /// Reads on the rollout file of `placed`'s thread, a thread no session streams that an
    /// export's response was just placed on, handing each charge it states since the launch
    /// registered to the session the response went to, at its placement; the file is then kept
    /// among the files let go. A file a stop's reading follows is left to that reading's passes,
    /// which the export named it to, and a thread found with no file is not looked for again.
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
            match found {
                Ok(Some((path, size))) => (
                    path,
                    CodexFollowedRollout {
                        file: CodexRolloutFile::default(),
                        offset: 0,
                        size,
                        placement: CodexRolloutPlacement::Unplaced { walks: 0 },
                        is_read_failed: false,
                    },
                ),
                Ok(None) => {
                    remember(&mut self.fileless, thread_id, FILELESS_KEPT);
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        conversation_id = thread_id.as_str(),
                        "a placed codex thread's rollout file could not be looked for"
                    );
                    return;
                }
            }
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
}
