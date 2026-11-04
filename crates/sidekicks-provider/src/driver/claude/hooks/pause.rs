//! Pause and continue on Claude Code, by the two hooks the daemon registers. A paused lead's batch
//! hook ends its turn after the step in flight and its tool hook denies; a paused helper's next
//! tool hook is held unanswered until it continues. Each pause reports when it took effect. A
//! message aimed at a helper a pause or an interrupt holds, or one stopped with every other agent,
//! is denied, so no agent wakes it around the hold.

use std::collections::HashMap;

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::scheduler::ScheduledJobHandle;

use crate::driver::claude::hooks::stopped_helpers::ClaudeStoppedHelpers;
use crate::driver::hook_pauses::{HELD_TARGET_REASON, HookPauses, PAUSED_REASON, PausedRole};
use crate::driver::run_control::HelperStopReason;

/// The reason a held helper's call is denied with before Claude Code's own bound would end the
/// hold, which the helper reads; the call it makes again is held anew.
pub(crate) const HELD_HELPER_RENEWAL_REASON: &str =
    "Still paused by the person. Make this same tool call again to keep waiting for them.";

/// A hook answer, written as the JSON Claude Code reads from the hook's output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeHookAnswer {
    /// No decision: `{}`.
    Pass,
    /// Denies the tool call, the model reading `reason` as why.
    Deny {
        /// What the model reads.
        reason: String,
    },
    /// Ends the turn after the step in flight.
    Stop {
        /// Why the turn stopped.
        reason: String,
    },
    /// Adds `context` for the model to read after the tool call it answers.
    AddContext {
        /// The hook's event, which Claude Code checks the answer against.
        hook_event_name: &'static str,
        /// What the model reads.
        context: String,
    },
    /// Keeps a finishing helper going, the helper reading `reason` as its next instruction.
    Block {
        /// What the helper reads.
        reason: String,
    },
}

// The `hookSpecificOutput` of an answer that adds context.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddedContext<'context> {
    hook_event_name: &'static str,
    additional_context: &'context str,
}

// The `hookSpecificOutput` of a pre-tool denial.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreToolUseDenial<'reason> {
    hook_event_name: &'static str,
    permission_decision: &'static str,
    permission_decision_reason: &'reason str,
}

impl Serialize for ClaudeHookAnswer {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Pass => serializer.serialize_map(Some(0))?.end(),
            Self::Deny { reason } => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry(
                    "hookSpecificOutput",
                    &PreToolUseDenial {
                        hook_event_name: "PreToolUse",
                        permission_decision: "deny",
                        permission_decision_reason: reason,
                    },
                )?;
                map.end()
            }
            Self::Stop { reason } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("continue", &false)?;
                map.serialize_entry("stopReason", reason)?;
                map.end()
            }
            Self::AddContext {
                hook_event_name,
                context,
            } => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry(
                    "hookSpecificOutput",
                    &AddedContext {
                        hook_event_name,
                        additional_context: context,
                    },
                )?;
                map.end()
            }
            Self::Block { reason } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("decision", "block")?;
                map.serialize_entry("reason", reason)?;
                map.end()
            }
        }
    }
}

/// How the pause answers one callback: at once, or held with no answer yet. `has_taken_effect`
/// marks the first hold of a helper's pause, the moment it took effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudePauseAnswer {
    /// Answer the callback now.
    Answer(ClaudeHookAnswer),
    /// Leave the callback unanswered until the helper continues.
    Hold {
        /// Whether this hold is the helper's pause taking effect.
        has_taken_effect: bool,
    },
}

/// One held callback a continue answers, and what it is answered with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeReleasedCallback {
    /// The callback's request id.
    pub(crate) request_id: String,
    /// Its answer.
    pub(crate) answer: ClaudeHookAnswer,
}

/// The renewal job standing for one held helper, with the id that tells it from a later one.
struct HoldRenewal {
    id: u64,
    job: ScheduledJobHandle,
}

/// Every session's pauses, the lead's and each helper's, the callbacks the pauses hold, and the
/// renewal standing for each held helper.
#[derive(Default)]
pub(crate) struct ClaudeRunPauses {
    /// Each session's lead pause and the run it stops; a lead holds no callback.
    lead_pauses: HookPauses<SessionId, RunId, ()>,
    /// Each paused helper, by session and agent id, and the request ids of its held callbacks.
    helper_pauses: HookPauses<(SessionId, String), (), String>,
    /// The stopped helpers, whose tool uses are denied.
    stopped_helpers: ClaudeStoppedHelpers,
    /// The one renewal job standing for each held helper, by session and agent id.
    renewals: HashMap<(SessionId, String), HoldRenewal>,
    /// The id the next renewal job takes.
    next_renewal_id: u64,
}

impl ClaudeRunPauses {
    /// Pauses the session's lead run from its next hook on; a pause already in place is kept.
    pub(crate) fn pause_lead(&mut self, session_id: &SessionId, run_id: &RunId) {
        self.lead_pauses
            .pause(*session_id, *session_id, PausedRole::Lead, *run_id);
    }

    /// Pauses one helper from its next tool call on.
    pub(crate) fn pause_helper(&mut self, session_id: &SessionId, agent_id: &str) {
        self.helper_pauses.pause(
            (*session_id, agent_id.to_owned()),
            *session_id,
            PausedRole::Helper,
            (),
        );
    }

    /// Stops the helper `agent_id` for `reason`: its tool uses are denied from the next on.
    pub(crate) fn stop_helper(
        &mut self,
        session_id: SessionId,
        agent_id: &str,
        reason: HelperStopReason,
    ) {
        self.stopped_helpers.stop(session_id, agent_id, reason);
    }

    /// Clears the helper `agent_id`'s stop as its new own run starts, unless the stop is final.
    pub(crate) fn release_helper(&mut self, session_id: SessionId, agent_id: &str) {
        self.stopped_helpers.release(session_id, agent_id);
    }

    /// Why the helper `agent_id` is stopped, `None` while it is not.
    pub(crate) fn helper_stop_reason(
        &self,
        session_id: &SessionId,
        agent_id: &str,
    ) -> Option<HelperStopReason> {
        self.stopped_helpers
            .stop_reason_of(*session_id, agent_id)
            .cloned()
    }

    /// Holds the helper `agent_id` an interrupt ended at its next tool call, as a pause does. The
    /// pause is marked as already in effect, so the first held call reports no `paused` on a run
    /// the interrupt already ended.
    pub(crate) fn hold_interrupted_helper(&mut self, session_id: &SessionId, agent_id: &str) {
        let helper = (*session_id, agent_id.to_owned());
        self.helper_pauses
            .pause(helper.clone(), *session_id, PausedRole::Helper, ());
        self.helper_pauses.mark_taken_effect(&helper);
    }

    /// Whether a pause holds the helper `agent_id`, the person's pause or an interrupt's hold.
    pub(crate) fn is_helper_held(&self, session_id: &SessionId, agent_id: &str) -> bool {
        self.helper_pauses
            .get(&(*session_id, agent_id.to_owned()))
            .is_some()
    }

    /// Answers a message call by the helper `agent_id` or the lead aimed at the helper `to`, from
    /// what memory holds: a stopped caller is denied with its own stop's sentence, a call aimed at
    /// a helper stopped with every other agent with that stop's, and one aimed at a helper a pause
    /// or an interrupt holds with [`HELD_TARGET_REASON`]. `None` leaves the call to the stored
    /// stop and then the pause; a target stopped any other way stays wakeable by its parent.
    pub(crate) fn answer_aimed_call(
        &self,
        session_id: &SessionId,
        agent_id: Option<&str>,
        to: &str,
    ) -> Option<ClaudeHookAnswer> {
        if let Some(denial) = self
            .stopped_helpers
            .answer_before_tool(*session_id, agent_id)
        {
            return Some(denial);
        }
        match self.stopped_helpers.stop_reason_of(*session_id, to) {
            Some(stop @ HelperStopReason::StopAll) => {
                return Some(ClaudeHookAnswer::Deny {
                    reason: stop.sentence(),
                });
            }
            Some(HelperStopReason::TokenLimit | HelperStopReason::SetupRefused { .. }) | None => {}
        }
        self.is_helper_held(session_id, to)
            .then(|| ClaudeHookAnswer::Deny {
                reason: HELD_TARGET_REASON.to_owned(),
            })
    }

    /// Answers a pre-tool callback: a stopped helper is denied, a paused lead's is denied, a
    /// paused helper's is held, any other passes with no decision. `agent_id` is the helper's,
    /// `None` on the lead.
    pub(crate) fn answer_before_tool(
        &mut self,
        session_id: &SessionId,
        agent_id: Option<&str>,
        request_id: &str,
    ) -> ClaudePauseAnswer {
        if let Some(denial) = self
            .stopped_helpers
            .answer_before_tool(*session_id, agent_id)
        {
            return ClaudePauseAnswer::Answer(denial);
        }
        let Some(agent_id) = agent_id else {
            if self.lead_pauses.get(session_id).is_some() {
                return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Deny {
                    reason: PAUSED_REASON.to_owned(),
                });
            }
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        };
        let helper = (*session_id, agent_id.to_owned());
        match self.helper_pauses.hold(&helper, request_id.to_owned()) {
            Some(has_taken_effect) => ClaudePauseAnswer::Hold { has_taken_effect },
            None => ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass),
        }
    }

    /// Answers a post-batch callback: a paused lead's ends the turn after the step in flight.
    /// Never used on a helper, where it would end the helper's run and the lead would invent its
    /// result.
    pub(crate) fn answer_after_batch(
        &mut self,
        session_id: &SessionId,
        agent_id: Option<&str>,
    ) -> ClaudePauseAnswer {
        let is_lead_paused = agent_id.is_none() && self.lead_pauses.mark_taken_effect(session_id);
        if !is_lead_paused {
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        }
        ClaudePauseAnswer::Answer(ClaudeHookAnswer::Stop {
            reason: PAUSED_REASON.to_owned(),
        })
    }

    /// The paused run whose turn just ended on its pause, or `None`. A turn that ended on its own
    /// leaves the pause armed for the next; the pause is reported once, so a turn Claude Code
    /// starts by itself and the pause stops again reports nothing new.
    pub(crate) fn take_lead_pause_effect(&mut self, session_id: &SessionId) -> Option<RunId> {
        self.lead_pauses.report_effect(session_id).copied()
    }

    /// The lead run whose pause already took effect and still holds, or `None`.
    pub(crate) fn reported_lead_pause(&self, session_id: &SessionId) -> Option<&RunId> {
        self.lead_pauses.reported(session_id)
    }

    /// Continues the lead; a pause that had not yet stopped a turn is dropped.
    pub(crate) fn resume_lead(&mut self, session_id: &SessionId) {
        self.lead_pauses.resume(session_id);
    }

    /// Continues one helper and answers the callbacks it was held on: with no decision, or denied
    /// with `steer` as the reason, which the helper reads as the person's words.
    pub(crate) fn resume_helper(
        &mut self,
        session_id: &SessionId,
        agent_id: &str,
        steer: Option<&str>,
    ) -> Vec<ClaudeReleasedCallback> {
        if let Some(renewal) = self.renewals.remove(&(*session_id, agent_id.to_owned())) {
            renewal.job.cancel();
        }
        let Some(ended) = self
            .helper_pauses
            .resume(&(*session_id, agent_id.to_owned()))
        else {
            return Vec::new();
        };
        let answer = match steer {
            Some(steer) => ClaudeHookAnswer::Deny {
                reason: steer.to_owned(),
            },
            None => ClaudeHookAnswer::Pass,
        };
        ended
            .held
            .into_iter()
            .map(|request_id| ClaudeReleasedCallback {
                request_id,
                answer: answer.clone(),
            })
            .collect()
    }

    /// Whether a renewal stands for the helper `agent_id`'s held calls.
    pub(crate) fn has_renewal(&self, session_id: &SessionId, agent_id: &str) -> bool {
        self.renewals
            .contains_key(&(*session_id, agent_id.to_owned()))
    }

    /// Mints the id of the next renewal job, which its run and its refusal name it by.
    pub(crate) fn mint_renewal_id(&mut self) -> u64 {
        let id = self.next_renewal_id;
        self.next_renewal_id += 1;
        id
    }

    /// Keeps `job`, minted `id`, as the one renewal standing for the helper `agent_id`'s held
    /// calls.
    pub(crate) fn keep_renewal(
        &mut self,
        session_id: SessionId,
        agent_id: String,
        id: u64,
        job: ScheduledJobHandle,
    ) {
        self.renewals
            .insert((session_id, agent_id), HoldRenewal { id, job });
    }

    /// Drops the renewal `renewal_id` standing for the helper `agent_id`, answering whether it was
    /// the one standing; a later renewal is left in place.
    pub(crate) fn drop_renewal(
        &mut self,
        session_id: &SessionId,
        agent_id: &str,
        renewal_id: u64,
    ) -> bool {
        let helper = (*session_id, agent_id.to_owned());
        let is_standing = self
            .renewals
            .get(&helper)
            .is_some_and(|renewal| renewal.id == renewal_id);
        if is_standing {
            self.renewals.remove(&helper);
        }
        is_standing
    }

    /// Takes the calls the helper `agent_id`'s pause holds as its renewal `renewal_id` falls due,
    /// each denied so the helper makes it again; the pause stays in force and holds the call it
    /// makes. A renewal no longer standing, one a continue ended while it ran, takes nothing.
    pub(crate) fn take_renewed_calls(
        &mut self,
        session_id: &SessionId,
        agent_id: &str,
        renewal_id: u64,
    ) -> Vec<ClaudeReleasedCallback> {
        if !self.drop_renewal(session_id, agent_id, renewal_id) {
            return Vec::new();
        }
        let helper = (*session_id, agent_id.to_owned());
        self.helper_pauses
            .take_held(&helper)
            .into_iter()
            .map(|request_id| ClaudeReleasedCallback {
                request_id,
                answer: ClaudeHookAnswer::Deny {
                    reason: HELD_HELPER_RENEWAL_REASON.to_owned(),
                },
            })
            .collect()
    }

    /// Drops a callback Claude Code withdrew; it will not be answered.
    pub(crate) fn withdraw_callback(&mut self, session_id: &SessionId, request_id: &str) {
        self.helper_pauses
            .withdraw_held(session_id, |held| held == request_id);
    }

    /// Forgets a session whose process is gone; its holds went with it.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.lead_pauses.forget_session(session_id);
        self.helper_pauses.forget_session(session_id);
        self.stopped_helpers.forget_session(session_id);
        self.renewals.retain(|(renewed_session_id, _), renewal| {
            let is_kept = renewed_session_id != session_id;
            if !is_kept {
                renewal.job.cancel();
            }
            is_kept
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use futures::FutureExt;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
    use sidekicks_std::scheduler::{JobCondition, Scheduler};
    use tokio::sync::watch;

    use super::{
        ClaudeHookAnswer, ClaudePauseAnswer, ClaudeReleasedCallback, ClaudeRunPauses,
        HELD_HELPER_RENEWAL_REASON,
    };
    use crate::driver::test_registry::fixed_session_id;

    fn bytes_of(answer: ClaudePauseAnswer) -> String {
        let ClaudePauseAnswer::Answer(answer) = answer else {
            panic!("the callback is answered at once, got {answer:?}");
        };
        serde_json::to_string(&answer).expect("a hook answer serializes")
    }

    #[test]
    fn a_paused_lead_is_denied_then_stopped_in_the_bytes_claude_code_reads() {
        let session_id = fixed_session_id();
        let run_id = RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id");
        let mut pauses = ClaudeRunPauses::default();
        assert_eq!(
            bytes_of(pauses.answer_before_tool(&session_id, None, "r0")),
            "{}"
        );

        pauses.pause_lead(&session_id, &run_id);

        assert_eq!(
            bytes_of(pauses.answer_before_tool(&session_id, None, "r1")),
            concat!(
                r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","#,
                r#""permissionDecision":"deny","permissionDecisionReason":"Paused by you"}}"#,
            )
        );
        assert_eq!(
            bytes_of(pauses.answer_after_batch(&session_id, None)),
            r#"{"continue":false,"stopReason":"Paused by you"}"#
        );
    }

    #[test]
    fn a_helper_pause_takes_effect_once_and_resumes_with_the_persons_words() {
        let session_id = fixed_session_id();
        let mut pauses = ClaudeRunPauses::default();
        pauses.pause_helper(&session_id, "helper-a");

        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-a"), "r1"),
            ClaudePauseAnswer::Hold {
                has_taken_effect: true
            }
        );
        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-a"), "r2"),
            ClaudePauseAnswer::Hold {
                has_taken_effect: false
            }
        );
        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-b"), "r3"),
            ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
        );

        let steer_answer = ClaudeHookAnswer::Deny {
            reason: "check the tests first".to_owned(),
        };
        assert_eq!(
            pauses.resume_helper(&session_id, "helper-a", Some("check the tests first")),
            [
                ClaudeReleasedCallback {
                    request_id: "r1".to_owned(),
                    answer: steer_answer.clone(),
                },
                ClaudeReleasedCallback {
                    request_id: "r2".to_owned(),
                    answer: steer_answer,
                },
            ]
        );

        pauses.pause_helper(&session_id, "helper-a");
        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-a"), "r4"),
            ClaudePauseAnswer::Hold {
                has_taken_effect: true
            }
        );
        assert_eq!(
            pauses.resume_helper(&session_id, "helper-a", None),
            [ClaudeReleasedCallback {
                request_id: "r4".to_owned(),
                answer: ClaudeHookAnswer::Pass,
            }]
        );
    }

    // Arms a renewal for the helper `agent_id` on `scheduler`, answering its id.
    fn arm(
        scheduler: &Scheduler,
        pauses: &mut ClaudeRunPauses,
        session_id: SessionId,
        agent_id: &str,
    ) -> u64 {
        let id = pauses.mint_renewal_id();
        let job = scheduler
            .schedule(
                "renewal",
                JobCondition::Always,
                Duration::from_hours(1),
                |_| async { Ok(()) }.boxed(),
            )
            .expect("the scheduler runs");
        pauses.keep_renewal(session_id, agent_id.to_owned(), id, job);
        id
    }

    // A renewal falling due after a continue ended it, once a later hold armed the next, takes
    // nothing and leaves the next standing to take the later hold's calls. Killed by a renewal
    // that takes the held calls whichever renewal it is.
    #[tokio::test]
    async fn an_ended_renewal_leaves_the_next_one_standing() {
        let scheduler = Scheduler::start(
            Arc::new(TestWallClock::default()),
            None,
            watch::channel(0).1,
        );
        let session_id = fixed_session_id();
        let mut pauses = ClaudeRunPauses::default();
        pauses.pause_helper(&session_id, "helper");
        pauses.answer_before_tool(&session_id, Some("helper"), "r1");
        let ended = arm(&scheduler, &mut pauses, session_id, "helper");
        pauses.resume_helper(&session_id, "helper", None);
        pauses.pause_helper(&session_id, "helper");
        pauses.answer_before_tool(&session_id, Some("helper"), "r2");
        let standing = arm(&scheduler, &mut pauses, session_id, "helper");

        assert_eq!(pauses.take_renewed_calls(&session_id, "helper", ended), []);
        assert!(pauses.has_renewal(&session_id, "helper"));
        assert_eq!(
            pauses.take_renewed_calls(&session_id, "helper", standing),
            [ClaudeReleasedCallback {
                request_id: "r2".to_owned(),
                answer: ClaudeHookAnswer::Deny {
                    reason: HELD_HELPER_RENEWAL_REASON.to_owned(),
                },
            }]
        );
        assert!(!pauses.has_renewal(&session_id, "helper"));
    }
}
