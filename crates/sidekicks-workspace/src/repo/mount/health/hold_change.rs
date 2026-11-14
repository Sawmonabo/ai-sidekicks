//! A held carry's cause or folder that an opener's ask found changed, told to each session on the
//! mount at once with the health the mount's last pass read, so the change runs no probe and waits
//! for no pass.

use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;

use super::verdict::MountVerdict;
use super::{MountPassFailure, RepoMountHealthReprobe, Told, settle_sends};

impl RepoMountHealthReprobe {
    /// Tells each session on the mount `repo_mount_id` the re-probe has told or read what holds
    /// its captures now, where that differs from what it heard, with the health the mount's last
    /// pass read, under the mount's pass lock. Tells nothing of a mount no pass has read, whose
    /// first pass tells it, nor a session not heard from yet, which the next pass reads from its
    /// log. Fails with [`MountPassFailure::Send`] once every session was tried; the mount's next
    /// pass sends each failed one again.
    pub(crate) async fn tell_captures_held(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<(), MountPassFailure> {
        let _pass = tokio::select! {
            biased;
            () = self.stop.cancelled() => return Ok(()),
            hold = self.passes.acquire(repo_mount_id) => hold,
        };
        let captures_held = self.packing.carries().captures_held(repo_mount_id);
        let Some((health, verdict, untold)) =
            self.lock_mounts().get(&repo_mount_id).and_then(|memory| {
                let health = memory.health.clone()?;
                let verdict = MountVerdict::of(&health, captures_held.clone());
                let untold: Vec<SessionId> = memory
                    .heard
                    .iter()
                    .filter(|(_, heard)| **heard != verdict)
                    .map(|(session_id, _)| *session_id)
                    .collect();
                Some((health, verdict, untold))
            })
        else {
            return Ok(());
        };
        let told = Told {
            repo_mount_id,
            health: &health,
            captures_held: captures_held.as_ref(),
            verdict: &verdict,
        };
        let mut sends = Vec::with_capacity(untold.len());
        for session_id in untold {
            // Cut short by the stop, the sessions not yet told keep what they heard.
            if self.stop.is_cancelled() {
                break;
            }
            sends.push(self.tell(session_id, &told, None).await);
        }
        settle_sends(repo_mount_id, sends)
    }
}
