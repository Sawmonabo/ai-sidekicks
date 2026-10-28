//! A Claude Code session's idle sleep, the driver's half: the holds only Claude Code keeps (the
//! requests it holds open on the person, a running side question, and the wake-ups and jobs its
//! `ScheduleWakeup`, `CronCreate` and `CronDelete` calls keep, read from their results as the
//! session's frames arrive), the stop that closes the process's input and keeps its conversation,
//! and the wake that resumes that conversation as it ran.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use jiff::{SignedDuration, Timestamp};
use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::contract::DriverError;
use crate::driver::idle_sleep::{IdleSleepHolds, KeptSchedule, SessionSleepState};
use crate::driver::session_control::ResumeSessionParams;
use crate::lenient_json::read_lenient;

/// Claude Code's tool that schedules the session's next wake-up, which its process loses when it
/// stops.
const SCHEDULE_WAKEUP_TOOL: &str = "ScheduleWakeup";

/// Claude Code's tool that makes a job, which a resume of the conversation restores.
const CRON_CREATE_TOOL: &str = "CronCreate";

/// Claude Code's tool that deletes a job by its id.
const CRON_DELETE_TOOL: &str = "CronDelete";

/// Claude Code's tool that lists every job the session keeps.
const CRON_LIST_TOOL: &str = "CronList";

/// The key prefix of a job taken from the daemon's stored schedules, its Claude Code id unknown.
const STORED_JOB_KEY_PREFIX: &str = "stored-";

/// How long a recurring job lives: Claude Code deletes one seven days after it was made.
const RECURRING_JOB_LIFETIME: SignedDuration = SignedDuration::from_hours(7 * 24);

/// What the driver keeps of each Claude Code session's idle sleep, across its processes and its
/// sleeps, until the session closes.
#[derive(Default)]
pub(crate) struct ClaudeIdleSleep {
    sessions: Mutex<HashMap<SessionId, SessionSleep>>,
}

// One session's holds and, while it sleeps, the resume that wakes it.
#[derive(Default)]
struct SessionSleep {
    // When each pending wake-up fires.
    wakeups: Vec<Timestamp>,
    // The jobs the session keeps, by Claude Code's id.
    jobs: HashMap<String, KeptJob>,
    // The calls whose result has not come yet, by their tool-use id.
    pending_calls: HashMap<String, PendingScheduleCall>,
    // The side questions running.
    side_questions: usize,
    // Set from the start of the session's stop until a process of it is up again.
    resume_on_wake: Option<ResumeSessionParams>,
}

// One job, as its making and the latest list told it.
struct KeptJob {
    cron: String,
    is_recurring: bool,
    next_fire_at: Option<Timestamp>,
    expires_at: Timestamp,
}

// A call of one of the scheduling tools, kept until its result comes.
enum PendingScheduleCall {
    Wakeup,
    CronCreate { cron: String },
    CronDelete { job_id: String },
    CronList,
}

/// A side question running on a session, which holds it awake until dropped.
pub(crate) struct ClaudeSideQuestionHold {
    sleep: Arc<ClaudeIdleSleep>,
    session_id: SessionId,
}

impl Drop for ClaudeSideQuestionHold {
    fn drop(&mut self) {
        if let Some(session) = lock(&self.sleep.sessions).get_mut(&self.session_id) {
            session.side_questions = session.side_questions.saturating_sub(1);
        }
    }
}

impl ClaudeIdleSleep {
    /// Reads the scheduling calls and their results out of one frame of the session's process:
    /// an `assistant` frame's calls of the scheduling tools, kept until their result comes, and a
    /// `user` frame's result of one of them, applied once it succeeded. A turn's `system/init`
    /// lets go the one-shot fires already past, since the turn they started holds the session
    /// itself. Frames are untrusted: one that reads otherwise changes nothing.
    pub(crate) fn observe_frame(&self, session_id: SessionId, frame_kind: &str, text: &str) {
        match frame_kind {
            "assistant" if mentions_schedule_tool(text) => {
                let calls = read_schedule_calls(text);
                if !calls.is_empty() {
                    lock(&self.sessions)
                        .entry(session_id)
                        .or_default()
                        .pending_calls
                        .extend(calls);
                }
            }
            "user" => {
                let is_waiting = lock(&self.sessions)
                    .get(&session_id)
                    .is_some_and(|session| !session.pending_calls.is_empty());
                if !is_waiting {
                    return;
                }
                let Ok(frame) = serde_json::from_str::<ClaudeMessageFrame>(text) else {
                    return;
                };
                let mut sessions = lock(&self.sessions);
                let Some(session) = sessions.get_mut(&session_id) else {
                    return;
                };
                let Some((call, is_error)) =
                    frame.tool_results().find_map(|(call_id, is_error)| {
                        Some((session.pending_calls.remove(call_id)?, is_error))
                    })
                else {
                    return;
                };
                if !is_error
                    && let Some(output) = frame
                        .tool_use_result()
                        .and_then(|output| serde_json::from_str::<Value>(output.get()).ok())
                {
                    session.apply(call, &output, Timestamp::now());
                }
            }
            "system/init" => {
                if let Some(session) = lock(&self.sessions).get_mut(&session_id) {
                    session.release_fired(Timestamp::now());
                }
            }
            _ => {}
        }
    }

    /// The process of the session ended: the wake-ups it kept and the calls it never answered are
    /// gone with it, and the jobs a resume restores stay.
    pub(crate) fn note_process_ended(&self, session_id: SessionId) {
        if let Some(session) = lock(&self.sessions).get_mut(&session_id) {
            session.wakeups.clear();
            session.pending_calls.clear();
        }
    }

    /// A process of the session is up, so it no longer sleeps.
    pub(crate) fn note_awake(&self, session_id: SessionId) {
        if let Some(session) = lock(&self.sessions).get_mut(&session_id) {
            session.resume_on_wake = None;
        }
    }

    /// Keeps the resume that wakes the session, whose stop begins now.
    pub(crate) fn keep_for_wake(&self, session_id: SessionId, resume: ResumeSessionParams) {
        lock(&self.sessions)
            .entry(session_id)
            .or_default()
            .resume_on_wake = Some(resume);
    }

    /// The resume that wakes the session; `None` while it is not asleep. It stays kept until a
    /// process of the session is up, so a wake that failed is tried again by the next.
    pub(crate) fn resume_for_wake(&self, session_id: SessionId) -> Option<ResumeSessionParams> {
        lock(&self.sessions)
            .get(&session_id)?
            .resume_on_wake
            .clone()
    }

    /// Whether the session is asleep or its stop for the sleep has begun.
    pub(crate) fn is_asleep(&self, session_id: SessionId) -> bool {
        lock(&self.sessions)
            .get(&session_id)
            .is_some_and(|session| session.resume_on_wake.is_some())
    }

    /// Holds the session awake for a side question until the hold drops.
    pub(crate) fn hold_side_question(
        self: &Arc<Self>,
        session_id: SessionId,
    ) -> ClaudeSideQuestionHold {
        lock(&self.sessions)
            .entry(session_id)
            .or_default()
            .side_questions += 1;
        ClaudeSideQuestionHold {
            sleep: Arc::clone(self),
            session_id,
        }
    }

    /// Takes the schedules the daemon stored for a session it found asleep after its own restart,
    /// as of `now`: each recurring job, and each single fire still ahead as a one-shot job, since
    /// the resume restores jobs and no wake-up. A later list from Claude Code replaces them.
    pub(crate) fn seed_schedules(
        &self,
        session_id: SessionId,
        schedules: Vec<KeptSchedule>,
        now: Timestamp,
    ) {
        let mut sessions = lock(&self.sessions);
        let session = sessions.entry(session_id).or_default();
        for (index, schedule) in schedules.into_iter().enumerate() {
            let job = match schedule {
                KeptSchedule::Recurring { cron, next_fire_at } => KeptJob {
                    cron,
                    is_recurring: true,
                    next_fire_at,
                    expires_at: now + RECURRING_JOB_LIFETIME,
                },
                KeptSchedule::Once { fires_at } if fires_at > now => KeptJob {
                    cron: String::new(),
                    is_recurring: false,
                    next_fire_at: Some(fires_at),
                    expires_at: fires_at,
                },
                KeptSchedule::Once { .. } => continue,
            };
            // Claude Code's ids were not stored; a key of its own keeps each job apart.
            session
                .jobs
                .insert(format!("{STORED_JOB_KEY_PREFIX}{index}"), job);
        }
    }

    /// Forgets a closed session.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.sessions).remove(&session_id);
    }

    // The session's holds as of `now`, the jobs expired by then let go.
    fn holds(&self, session_id: SessionId, open_requests: u32, now: Timestamp) -> IdleSleepHolds {
        let mut sessions = lock(&self.sessions);
        let Some(session) = sessions.get_mut(&session_id) else {
            return IdleSleepHolds {
                open_requests,
                ..IdleSleepHolds::default()
            };
        };
        session
            .jobs
            .retain(|_, job| !job.is_recurring || job.expires_at > now);
        IdleSleepHolds {
            open_requests,
            is_side_question_running: session.side_questions > 0,
            schedules: session.kept_schedules(now),
        }
    }
}

impl SessionSleep {
    // Applies one call's successful `output`, read at `now`.
    fn apply(&mut self, call: PendingScheduleCall, output: &Value, now: Timestamp) {
        match call {
            PendingScheduleCall::Wakeup => {
                if output.get("stopped").and_then(Value::as_bool) == Some(true) {
                    self.wakeups.clear();
                } else if let Some(fires_at) = read_epoch_milliseconds(output.get("scheduledFor")) {
                    self.wakeups.push(fires_at);
                }
            }
            PendingScheduleCall::CronCreate { cron } => {
                let Some(job_id) = output.get("id").and_then(Value::as_str) else {
                    return;
                };
                self.jobs.insert(
                    job_id.to_owned(),
                    KeptJob {
                        cron,
                        is_recurring: read_recurring(output),
                        next_fire_at: read_epoch_milliseconds(output.get("nextFireAt")),
                        expires_at: now + RECURRING_JOB_LIFETIME,
                    },
                );
            }
            PendingScheduleCall::CronDelete { job_id } => {
                self.jobs.remove(&job_id);
            }
            PendingScheduleCall::CronList => {
                let Some(listed) = output.get("jobs").and_then(Value::as_array) else {
                    return;
                };
                let mut jobs = HashMap::with_capacity(listed.len());
                for listed_job in listed {
                    let (Some(job_id), Some(cron)) = (
                        listed_job.get("id").and_then(Value::as_str),
                        listed_job.get("cron").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    // A job made before the driver saw it expires at the latest a lifetime from
                    // now.
                    let expires_at = self
                        .jobs
                        .get(job_id)
                        .map_or(now + RECURRING_JOB_LIFETIME, |known| known.expires_at);
                    jobs.insert(
                        job_id.to_owned(),
                        KeptJob {
                            cron: cron.to_owned(),
                            is_recurring: read_recurring(listed_job),
                            next_fire_at: read_epoch_milliseconds(listed_job.get("nextFireAt")),
                            expires_at,
                        },
                    );
                }
                self.jobs = jobs;
            }
        }
    }

    // A turn began at `now`: each one-shot fire already past started it or an earlier one.
    fn release_fired(&mut self, now: Timestamp) {
        self.wakeups.retain(|fires_at| *fires_at > now);
        self.jobs.retain(|_, job| {
            job.is_recurring || job.next_fire_at.is_none_or(|fires_at| fires_at > now)
        });
    }

    // The timed fires the session keeps as of `now`: each wake-up and one-shot job a single fire,
    // a recurring job by its schedule, its next fire named only while it is still ahead.
    fn kept_schedules(&self, now: Timestamp) -> Vec<KeptSchedule> {
        let wakeups = self.wakeups.iter().map(|fires_at| KeptSchedule::Once {
            fires_at: *fires_at,
        });
        let jobs = self.jobs.values().map(|job| {
            let next_fire_at = job.next_fire_at.filter(|fires_at| *fires_at > now);
            match (job.is_recurring, job.next_fire_at) {
                (false, Some(fires_at)) => KeptSchedule::Once { fires_at },
                // A one-shot job whose fire Claude Code did not say fires at its schedule's next
                // match, which a resume still restores, so it is kept by its schedule.
                (true, _) | (false, None) => KeptSchedule::Recurring {
                    cron: job.cron.clone(),
                    next_fire_at,
                },
            }
        });
        wakeups.chain(jobs).collect()
    }
}

impl ClaudeDriver {
    /// The holds only Claude Code keeps on the session: the requests it holds open on the person,
    /// its background work other than commands (a tool server's call, a helper's or a workflow's
    /// task), a side question running, and the wake-ups and jobs its calls keep. A session the
    /// driver holds nothing for answers no hold.
    pub(crate) async fn idle_sleep_holds(
        &self,
        session_id: SessionId,
    ) -> Result<IdleSleepHolds, DriverError> {
        let Some(parts) = self.composed_parts() else {
            return Ok(IdleSleepHolds::default());
        };
        let task_services = &parts.establishment.task_services;
        // Background work holds the session as an open request does: a stop would kill it.
        let background_work = task_services
            .streams
            .get(session_id)
            .map_or(0, |stream| stream.background_work());
        let open_requests = task_services
            .requests
            .open_request_count(session_id)
            .saturating_add(u32::try_from(background_work).unwrap_or(u32::MAX));
        Ok(parts.establishment.task_services.idle_sleep.holds(
            session_id,
            open_requests,
            Timestamp::now(),
        ))
    }

    /// Stops the session's process for the idle sleep: its input closes, so Claude Code finishes
    /// writing its conversation, and the answer comes once it exited, the binding, conversation,
    /// account, settings and inbox kept. A session with no process the driver started here, such
    /// as one the person runs in their own terminal, is never stopped and answers `Awake`.
    pub(crate) async fn sleep_session(
        &self,
        session_id: SessionId,
    ) -> Result<SessionSleepState, DriverError> {
        let Some(parts) = self.composed_parts() else {
            return Ok(SessionSleepState::Awake);
        };
        let idle_sleep = &parts.establishment.task_services.idle_sleep;
        if idle_sleep.is_asleep(session_id) {
            return Ok(SessionSleepState::Asleep);
        }
        let Some(live) = parts.slots().live_session(session_id) else {
            return Ok(SessionSleepState::Awake);
        };
        let Some((close, resume)) = parts.restarts.begin_sleep(&live) else {
            return Ok(SessionSleepState::Awake);
        };
        // Kept before the stop, so a send arriving while it stops wakes the session after it.
        idle_sleep.keep_for_wake(session_id, resume);
        parts.restarts.finish_sleep(close, &live).await;
        Ok(SessionSleepState::Asleep)
    }

    /// Wakes a sleeping session: its conversation resumes by id on the same account, folder,
    /// settings and level, and the bring-up reads the command list and tool servers again and
    /// measures spend from what the conversation already reported. A session this daemon put to
    /// sleep resumes as it ran; one found asleep after a restart of the daemon resumes from its
    /// stored binding. A session with a live process, or one that never ran, answers `Awake` at
    /// once. Fails with the resume's failure, the session left asleep.
    pub(crate) async fn wake_session(
        &self,
        session_id: SessionId,
    ) -> Result<SessionSleepState, DriverError> {
        let parts = self.parts()?;
        let idle_sleep = &parts.establishment.task_services.idle_sleep;
        let resume = match idle_sleep.resume_for_wake(session_id) {
            Some(resume) => resume,
            None if parts.slots().holds_slot(session_id) => return Ok(SessionSleepState::Awake),
            None => {
                let stored = self
                    .sources
                    .ports
                    .session_resumes
                    .require_port()
                    .map_err(|error| DriverError::Internal(Box::new(error)))?
                    .read_resume(session_id)
                    .await
                    .map_err(DriverError::Internal)?;
                let Some(stored) = stored else {
                    return Ok(SessionSleepState::Awake);
                };
                idle_sleep.seed_schedules(session_id, stored.schedules, Timestamp::now());
                stored.params
            }
        };
        parts.restarts.wake(resume).await?;
        Ok(SessionSleepState::Awake)
    }
}

// Whether `text` names a scheduling tool, so an `assistant` frame naming none is never parsed.
fn mentions_schedule_tool(text: &str) -> bool {
    [
        SCHEDULE_WAKEUP_TOOL,
        CRON_CREATE_TOOL,
        CRON_DELETE_TOOL,
        CRON_LIST_TOOL,
    ]
    .iter()
    .any(|tool_name| text.contains(tool_name))
}

// The members of a scheduling call's input that are read.
#[derive(Default, Deserialize)]
struct ScheduleCallInput {
    #[serde(default, deserialize_with = "read_lenient")]
    cron: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
}

// The scheduling calls an `assistant` frame makes, by their tool-use id.
fn read_schedule_calls(text: &str) -> Vec<(String, PendingScheduleCall)> {
    let Ok(frame) = serde_json::from_str::<ClaudeMessageFrame>(text) else {
        return Vec::new();
    };
    frame
        .tool_uses()
        .filter_map(|(call_id, tool_name, input)| {
            let input = || {
                input
                    .and_then(|input| serde_json::from_str::<ScheduleCallInput>(input.get()).ok())
                    .unwrap_or_default()
            };
            let call = match tool_name {
                SCHEDULE_WAKEUP_TOOL => PendingScheduleCall::Wakeup,
                CRON_CREATE_TOOL => PendingScheduleCall::CronCreate {
                    cron: input().cron?,
                },
                CRON_DELETE_TOOL => PendingScheduleCall::CronDelete {
                    job_id: input().id?,
                },
                CRON_LIST_TOOL => PendingScheduleCall::CronList,
                _ => return None,
            };
            Some((call_id.to_owned(), call))
        })
        .collect()
}

// A job's `recurring`, which Claude Code takes as true where a job leaves it out.
fn read_recurring(job: &Value) -> bool {
    job.get("recurring")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

// An epoch-milliseconds member; `None` when absent or no whole instant.
fn read_epoch_milliseconds(member: Option<&Value>) -> Option<Timestamp> {
    Timestamp::from_millisecond(member?.as_i64()?).ok()
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use serde_json::json;

    use super::ClaudeIdleSleep;
    use crate::driver::idle_sleep::KeptSchedule;
    use crate::driver::test_registry::new_session_id;

    // Killed by a process end, a stop for the sleep among them, that empties the jobs a resume
    // restores, and by one that keeps the wake-ups the stopped process lost.
    #[test]
    fn a_recurring_job_outlives_the_process_and_its_wake_up_does_not() {
        let sleep = ClaudeIdleSleep::default();
        let session_id = new_session_id();
        let fires_at = Timestamp::now().as_millisecond() + 3_600_000;
        let calls = json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "wake", "name": "ScheduleWakeup", "input": {}},
            {"type": "tool_use", "id": "job", "name": "CronCreate",
                "input": {"cron": "*/5 * * * *", "prompt": "check"}},
        ]}});
        let results = |call_id: &str, output: serde_json::Value| {
            json!({"type": "user", "tool_use_result": output, "message": {"content": [
                {"type": "tool_result", "tool_use_id": call_id},
            ]}})
            .to_string()
        };

        sleep.observe_frame(session_id, "assistant", &calls.to_string());
        sleep.observe_frame(
            session_id,
            "user",
            &results("wake", json!({"scheduledFor": fires_at})),
        );
        sleep.observe_frame(
            session_id,
            "user",
            &results("job", json!({"id": "job-1", "recurring": true})),
        );
        let before = sleep.holds(session_id, 0, Timestamp::now()).schedules;
        sleep.note_process_ended(session_id);
        sleep.note_awake(session_id);
        let after = sleep.holds(session_id, 0, Timestamp::now()).schedules;

        assert_eq!(before.len(), 2, "{before:?}");
        assert_eq!(
            after,
            vec![KeptSchedule::Recurring {
                cron: "*/5 * * * *".to_owned(),
                next_fire_at: None,
            }]
        );
    }

    // Killed by a wake from the stored schedules that answers no job, which lets the idle sleep
    // stop a session whose recurring job Claude Code restored, and by one that keeps a fire
    // already past.
    #[test]
    fn the_stored_recurring_job_is_answered_after_a_wake_from_the_daemon_s_record() {
        let sleep = ClaudeIdleSleep::default();
        let session_id = new_session_id();
        let now = Timestamp::now();
        let past = Timestamp::from_millisecond(now.as_millisecond() - 60_000)
            .expect("a minute ago is an instant");
        let recurring = KeptSchedule::Recurring {
            cron: "0 9 * * *".to_owned(),
            next_fire_at: None,
        };

        sleep.seed_schedules(
            session_id,
            vec![recurring.clone(), KeptSchedule::Once { fires_at: past }],
            now,
        );

        assert_eq!(sleep.holds(session_id, 0, now).schedules, vec![recurring]);
    }
}
