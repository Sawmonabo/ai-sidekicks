//! Pause and continue on Claude Code, by the two hooks the daemon registers. A paused lead's batch
//! hook ends its turn after the step in flight and its tool hook denies; a paused helper's next
//! tool hook is held unanswered until it continues. Each pause reports when it took effect.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

/// The reason a paused lead's hooks give Claude Code, which the model reads.
const CLAUDE_PAUSED_REASON: &str = "Paused by you";

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

// A pre-tool callback a paused helper is held on.
struct HeldToolCallback {
    request_id: String,
    agent_id: String,
}

// The session's lead pause: its run, and whether a hook has stopped the turn on it yet.
struct ClaudeLeadPause {
    run_id: RunId,
    is_stop_answered: bool,
    is_effect_reported: bool,
}

/// Every session's pauses, the lead's and each helper's, and the callbacks the pauses hold.
#[derive(Default)]
pub(crate) struct ClaudeRunPauses {
    lead_pauses: HashMap<SessionId, ClaudeLeadPause>,
    paused_agents: HashMap<SessionId, HashSet<String>>,
    held_callbacks: HashMap<SessionId, Vec<HeldToolCallback>>,
}

impl ClaudeRunPauses {
    /// Pauses the session's lead run from its next hook on; a pause already in place is kept.
    pub(crate) fn pause_lead(&mut self, session_id: &SessionId, run_id: &RunId) {
        self.lead_pauses
            .entry(session_id.clone())
            .or_insert_with(|| ClaudeLeadPause {
                run_id: run_id.clone(),
                is_stop_answered: false,
                is_effect_reported: false,
            });
    }

    /// Pauses one helper from its next tool call on.
    pub(crate) fn pause_helper(&mut self, session_id: &SessionId, agent_id: &str) {
        self.paused_agents
            .entry(session_id.clone())
            .or_default()
            .insert(agent_id.to_owned());
    }

    /// Answers a pre-tool callback: a paused lead's is denied, a paused helper's is held, any
    /// other passes with no decision. `agent_id` is the helper's, `None` on the lead.
    pub(crate) fn answer_before_tool(
        &mut self,
        session_id: &SessionId,
        agent_id: Option<&str>,
        request_id: &str,
    ) -> ClaudePauseAnswer {
        let Some(agent_id) = agent_id else {
            if self.lead_pauses.contains_key(session_id) {
                return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Deny {
                    reason: CLAUDE_PAUSED_REASON.to_owned(),
                });
            }
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        };
        let is_paused = self
            .paused_agents
            .get(session_id)
            .is_some_and(|paused| paused.contains(agent_id));
        if !is_paused {
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        }
        let held = self.held_callbacks.entry(session_id.clone()).or_default();
        let has_taken_effect = !held.iter().any(|callback| callback.agent_id == agent_id);
        held.push(HeldToolCallback {
            request_id: request_id.to_owned(),
            agent_id: agent_id.to_owned(),
        });
        ClaudePauseAnswer::Hold { has_taken_effect }
    }

    /// Answers a post-batch callback: a paused lead's ends the turn after the step in flight.
    /// Never used on a helper, where it would end the helper's run and the lead would invent its
    /// result.
    pub(crate) fn answer_after_batch(
        &mut self,
        session_id: &SessionId,
        agent_id: Option<&str>,
    ) -> ClaudePauseAnswer {
        let lead_pause = match agent_id {
            None => self.lead_pauses.get_mut(session_id),
            Some(_) => None,
        };
        let Some(lead_pause) = lead_pause else {
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        };
        lead_pause.is_stop_answered = true;
        ClaudePauseAnswer::Answer(ClaudeHookAnswer::Stop {
            reason: CLAUDE_PAUSED_REASON.to_owned(),
        })
    }

    /// The paused run whose turn just ended on its pause, or `None`. A turn that ended on its own
    /// leaves the pause armed for the next; the pause is reported once, so a turn Claude Code
    /// starts by itself and the pause stops again reports nothing new.
    pub(crate) fn take_lead_pause_effect(&mut self, session_id: &SessionId) -> Option<RunId> {
        let lead_pause = self.lead_pauses.get_mut(session_id)?;
        if !lead_pause.is_stop_answered || lead_pause.is_effect_reported {
            return None;
        }
        lead_pause.is_effect_reported = true;
        Some(lead_pause.run_id.clone())
    }

    /// The lead run whose pause already took effect and still holds, or `None`.
    pub(crate) fn reported_lead_pause(&self, session_id: &SessionId) -> Option<&RunId> {
        self.lead_pauses
            .get(session_id)
            .filter(|lead_pause| lead_pause.is_effect_reported)
            .map(|lead_pause| &lead_pause.run_id)
    }

    /// Continues the lead; a pause that had not yet stopped a turn is dropped.
    pub(crate) fn resume_lead(&mut self, session_id: &SessionId) {
        self.lead_pauses.remove(session_id);
    }

    /// Continues one helper and answers the callbacks it was held on: with no decision, or denied
    /// with `steer` as the reason, which the helper reads as the person's words.
    pub(crate) fn resume_helper(
        &mut self,
        session_id: &SessionId,
        agent_id: &str,
        steer: Option<&str>,
    ) -> Vec<ClaudeReleasedCallback> {
        if let Some(paused) = self.paused_agents.get_mut(session_id) {
            paused.remove(agent_id);
        }
        let Some(held) = self.held_callbacks.get_mut(session_id) else {
            return Vec::new();
        };
        let answer = match steer {
            Some(steer) => ClaudeHookAnswer::Deny {
                reason: steer.to_owned(),
            },
            None => ClaudeHookAnswer::Pass,
        };
        let (released, still_held): (Vec<HeldToolCallback>, Vec<HeldToolCallback>) =
            std::mem::take(held)
                .into_iter()
                .partition(|callback| callback.agent_id == agent_id);
        *held = still_held;
        released
            .into_iter()
            .map(|callback| ClaudeReleasedCallback {
                request_id: callback.request_id,
                answer: answer.clone(),
            })
            .collect()
    }

    /// Drops a callback Claude Code withdrew; it will not be answered.
    pub(crate) fn withdraw_callback(&mut self, session_id: &SessionId, request_id: &str) {
        if let Some(held) = self.held_callbacks.get_mut(session_id) {
            held.retain(|callback| callback.request_id != request_id);
        }
    }

    /// Forgets a session whose process is gone; its holds went with it.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.lead_pauses.remove(session_id);
        self.paused_agents.remove(session_id);
        self.held_callbacks.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;

    use super::{ClaudeHookAnswer, ClaudePauseAnswer, ClaudeReleasedCallback, ClaudeRunPauses};

    fn session_id() -> SessionId {
        SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d".to_owned())
            .expect("a valid session id")
    }

    fn bytes_of(answer: ClaudePauseAnswer) -> String {
        let ClaudePauseAnswer::Answer(answer) = answer else {
            panic!("the callback is answered at once, got {answer:?}");
        };
        serde_json::to_string(&answer).expect("a hook answer serializes")
    }

    #[test]
    fn a_paused_lead_is_denied_then_stopped_in_the_bytes_claude_code_reads() {
        let session_id = session_id();
        let run_id =
            RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e".to_owned()).expect("a valid run id");
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
        let session_id = session_id();
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
}
