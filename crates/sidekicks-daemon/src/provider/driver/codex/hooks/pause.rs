//! Pause and continue on Codex by the daemon's hooks. A paused helper's next pre-tool call is held
//! until it continues, and the words waiting for it reach it at its next post-tool hook. A paused
//! lead's next pre-tool call is parked until run control has sent its turn's interrupt, then
//! denied, so the parked call never runs. The first call held is the pause taking effect.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::provider::driver::codex::hooks::server::{
    CodexHookAnswer, CodexHookAnswerer, CodexHookEvent, CodexHookInput,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::hook_pauses::{EndedHookPause, HookPauses, PAUSED_REASON, PausedRole};

/// The run a conversation's pause stops, and the binding its `paused` is delivered on.
#[expect(
    clippy::struct_field_names,
    reason = "each member is the id of what it names"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexHookPause {
    /// The session the conversation belongs to.
    pub(crate) session_id: SessionId,
    /// The run the pause stops.
    pub(crate) run_id: RunId,
    /// The binding the run's `paused` is delivered on.
    pub(crate) binding_id: String,
}

/// What the pauses tell run control and ask of it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex run control acts on a pause when it takes effect"
    )
)]
pub(crate) trait CodexPauseRunControl: Send + Sync {
    /// The pause's first held call: the run stopped there. For a lead, run control sends the
    /// turn's interrupt and then calls [`CodexRunPauses::interrupt_sent`]. Never fails; what fails
    /// is run control's to report.
    fn on_took_effect(&self, pause: &CodexHookPause);

    /// Whether `run_id` is still live; a pause outliving its run holds nothing.
    fn is_run_live(&self, run_id: &RunId) -> bool;
}

/// A held pre-tool call: answered through it, or let go when it is dropped.
type HeldCall = oneshot::Sender<CodexHookAnswer>;

/// The words a continued conversation reads at its next post-tool hook.
struct WaitingWords {
    session_id: SessionId,
    words: String,
}

/// The pauses in force, the paused leads whose turn's interrupt was sent, and the words waiting,
/// keyed by thread id.
#[derive(Default)]
struct PauseState {
    pauses: HookPauses<String, CodexHookPause, HeldCall>,
    interrupt_sent_threads: HashSet<String>,
    words_by_thread_id: HashMap<String, WaitingWords>,
}

impl PauseState {
    // Ends `thread_id`'s pause, the interrupt sent for it forgotten with it.
    fn end_pause(&mut self, thread_id: &str) -> Option<EndedHookPause<CodexHookPause, HeldCall>> {
        self.interrupt_sent_threads.remove(thread_id);
        self.pauses.resume(&thread_id.to_owned())
    }
}

/// Every Codex conversation's hook pause, the lead's and each helper's, and the words waiting for
/// a continued helper's next finished call.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex run control pauses and continues runs through it"
    )
)]
pub(crate) struct CodexRunPauses {
    /// Told when a pause takes effect, and asked whether a pause's run is live.
    run_control: Arc<dyn CodexPauseRunControl>,
    /// Never held across an await.
    state: Mutex<PauseState>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex run control pauses and continues runs through it"
    )
)]
impl CodexRunPauses {
    /// Pauses that tell `run_control` when each takes effect.
    pub(crate) fn new(run_control: Arc<dyn CodexPauseRunControl>) -> Self {
        Self {
            run_control,
            state: Mutex::new(PauseState::default()),
        }
    }

    /// Pauses the conversation `thread_id`, the lead's or a helper's as `role` says, from its next
    /// tool call on; a pause already there stays as it is.
    pub(crate) fn pause(&self, thread_id: &str, role: PausedRole, pause: CodexHookPause) {
        let session_id = pause.session_id;
        self.lock()
            .pauses
            .pause(thread_id.to_owned(), session_id, role, pause);
    }

    /// The conversation `run_id`'s pause is on, or `None` when none is.
    pub(crate) fn thread_paused_for(&self, run_id: &RunId) -> Option<String> {
        self.lock()
            .pauses
            .find(|pause| pause.detail().run_id == *run_id)
            .cloned()
    }

    /// Run control sent the paused lead's turn its interrupt: the lead's held calls are denied
    /// now, and so is every later pre-tool call until it continues. A helper's pause is not
    /// parked this way, so it is left as it is.
    pub(crate) fn interrupt_sent(&self, thread_id: &str) {
        let thread_id = thread_id.to_owned();
        let parked = {
            let mut state = self.lock();
            let is_paused_lead = state
                .pauses
                .get(&thread_id)
                .is_some_and(|pause| pause.role() == PausedRole::Lead);
            if !is_paused_lead {
                return;
            }
            // From the interrupt on, the lead's pre-tool calls are denied at once.
            state.pauses.mark_taken_effect(&thread_id);
            state.interrupt_sent_threads.insert(thread_id.clone());
            state.pauses.take_held(&thread_id)
        };
        for call in parked {
            if call.send(paused_denial()).is_err() {
                tracing::debug!(
                    thread_id = thread_id.as_str(),
                    "a parked Codex hook call stopped waiting before its denial"
                );
            }
        }
    }

    /// Continues the conversation `thread_id`: its held calls are let go to the answerers after
    /// the pauses, and `words`, when given, reach it at its next finished call. Answers whether
    /// the pause had taken effect; `false` when it was not paused.
    pub(crate) fn resume(&self, thread_id: &str, words: Option<String>) -> bool {
        let mut state = self.lock();
        let Some(EndedHookPause {
            detail,
            held,
            had_taken_effect,
        }) = state.end_pause(thread_id)
        else {
            return false;
        };
        // A dropped hold lets its call go on to the next answerer, so a continued call still
        // meets every check after the pause, and passes when none answers.
        drop(held);
        if let Some(words) = words {
            state.words_by_thread_id.insert(
                thread_id.to_owned(),
                WaitingWords {
                    session_id: detail.session_id,
                    words,
                },
            );
        }
        had_taken_effect
    }

    // Answers a pre-tool call: held while its conversation is paused, denied at once on a lead
    // whose interrupt was sent. `None` lets the next answerer answer.
    async fn hold_call(
        &self,
        thread_id: &str,
        token: &CancellationToken,
    ) -> Option<CodexHookAnswer> {
        let thread_id = &thread_id.to_owned();
        let run_id = self.lock().pauses.get(thread_id)?.detail().run_id;
        // A service that crashed or a session let go leaves its pause behind with no run to stop.
        if !self.run_control.is_run_live(&run_id) {
            self.lock().end_pause(thread_id);
            return None;
        }
        let (held_call, answered) = oneshot::channel();
        let took_effect = {
            let mut state = self.lock();
            let pause = state.pauses.get(thread_id)?;
            let session_id = *pause.session_id();
            if pause.role() == PausedRole::Lead && state.interrupt_sent_threads.contains(thread_id)
            {
                return Some(paused_denial());
            }
            // Calls that stopped waiting leave the hold, so a long pause keeps only live ones.
            state
                .pauses
                .withdraw_held(&session_id, oneshot::Sender::is_closed);
            let is_taking_effect = state.pauses.hold(thread_id, held_call)?;
            if is_taking_effect {
                state
                    .pauses
                    .get(thread_id)
                    .map(|pause| pause.detail().clone())
            } else {
                None
            }
        };
        if let Some(pause) = &took_effect {
            self.run_control.on_took_effect(pause);
        }
        // The hold ends by an answer, by the call no longer waiting, or by its pause letting go;
        // never by a timer, and the pause stays recorded against its run.
        tokio::select! {
            biased;
            () = token.cancelled() => None,
            answer = answered => answer.ok(),
        }
    }

    // Answers a post-tool call with the words waiting for its conversation, once.
    fn take_words(&self, thread_id: &str) -> Option<CodexHookAnswer> {
        let waiting = self.lock().words_by_thread_id.remove(thread_id)?;
        Some(CodexHookAnswer::Context {
            additional_context: waiting.words,
        })
    }

    fn lock(&self) -> MutexGuard<'_, PauseState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[expect(
    dead_code,
    reason = "the Codex session lets go of a conversation or a session that ended"
)]
impl CodexRunPauses {
    /// Lets go of a conversation that ended: its held calls are let go and its waiting words
    /// leave.
    pub(crate) fn forget_thread(&self, thread_id: &str) {
        let mut state = self.lock();
        state.end_pause(thread_id);
        state.words_by_thread_id.remove(thread_id);
    }

    /// Lets go of every pause and waiting word of `session_id`, whose conversations are gone.
    pub(crate) fn forget_session(&self, session_id: &SessionId) {
        let mut state = self.lock();
        for (thread_id, _) in state.pauses.forget_session(session_id) {
            state.interrupt_sent_threads.remove(&thread_id);
        }
        state
            .words_by_thread_id
            .retain(|_, waiting| waiting.session_id != *session_id);
    }
}

impl CodexHookAnswerer for CodexRunPauses {
    /// A pre-tool call is held or denied by its conversation's pause; a post-tool call takes the
    /// words waiting for it. Never fails.
    fn answer<'a>(
        &'a self,
        input: &'a CodexHookInput,
        token: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<CodexHookAnswer>, CodexError>> {
        match input.event {
            CodexHookEvent::PreToolUse => {
                async move { Ok(self.hold_call(&input.thread_id, token).await) }.boxed()
            }
            CodexHookEvent::PostToolUse => {
                let words = self.take_words(&input.thread_id);
                async move { Ok(words) }.boxed()
            }
        }
    }
}

// The answer a paused lead's call gets; the model reads the reason.
fn paused_denial() -> CodexHookAnswer {
    CodexHookAnswer::Deny {
        reason: PAUSED_REASON.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::{Map, Value};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use tokio::task::JoinHandle;
    use tokio_util::sync::CancellationToken;

    use super::{CodexHookPause, CodexPauseRunControl, CodexRunPauses, paused_denial};
    use crate::provider::driver::codex::hooks::server::{
        CodexHookAnswer, CodexHookAnswerer, CodexHookCall, CodexHookDispatch, CodexHookEvent,
        CodexHookInput,
    };
    use crate::provider::driver::hook_pauses::PausedRole;

    const LEAD: &str = "thread-lead";
    const HELPER: &str = "thread-helper";

    /// Longer than any hold a timer could end.
    const FAR_AHEAD: Duration = Duration::from_secs(1_000_000_000);

    /// Counts the pauses that took effect, with every run live unless told otherwise.
    #[derive(Default)]
    struct RecordingRunControl {
        took_effect: AtomicUsize,
        is_run_ended: AtomicBool,
    }

    impl CodexPauseRunControl for RecordingRunControl {
        fn on_took_effect(&self, _pause: &CodexHookPause) {
            self.took_effect.fetch_add(1, Ordering::SeqCst);
        }

        fn is_run_live(&self, _run_id: &RunId) -> bool {
            !self.is_run_ended.load(Ordering::SeqCst)
        }
    }

    fn run_id() -> RunId {
        RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id")
    }

    fn pause() -> CodexHookPause {
        CodexHookPause {
            session_id: SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d")
                .expect("a valid session id"),
            run_id: run_id(),
            binding_id: "binding-1".to_owned(),
        }
    }

    fn pauses() -> (Arc<CodexRunPauses>, Arc<RecordingRunControl>) {
        let run_control = Arc::new(RecordingRunControl::default());
        let pauses = Arc::new(CodexRunPauses::new(run_control.clone()));
        (pauses, run_control)
    }

    // One hook call on `thread_id` through a dispatch point whose only answerer is the pauses; the
    // arguments name the lead's thread as the session, so only `_meta` tells a helper's call.
    fn call(
        pauses: &Arc<CodexRunPauses>,
        event: CodexHookEvent,
        thread_id: &str,
    ) -> JoinHandle<Option<CodexHookAnswer>> {
        let dispatch = CodexHookDispatch::new(vec![pauses.clone()]);
        let event_name = match event {
            CodexHookEvent::PreToolUse => "PreToolUse",
            CodexHookEvent::PostToolUse => "PostToolUse",
        };
        let hook_call = CodexHookCall {
            arguments: Map::from_iter([
                ("hook_event_name".to_owned(), Value::from(event_name)),
                ("session_id".to_owned(), Value::from(LEAD)),
            ]),
            meta: Map::from_iter([("threadId".to_owned(), Value::from(thread_id))]),
        };
        tokio::spawn(async move {
            dispatch
                .answer(event, hook_call, &CancellationToken::new())
                .await
        })
    }

    async fn is_still_held<Answer>(call: &mut JoinHandle<Answer>) -> bool {
        tokio::time::timeout(FAR_AHEAD, call).await.is_err()
    }

    async fn settled<Answer>(call: JoinHandle<Answer>) -> Answer {
        tokio::time::timeout(Duration::from_secs(1), call)
            .await
            .expect("the call is answered")
            .expect("the call's task ends")
    }

    #[tokio::test(start_paused = true)]
    async fn a_parked_lead_call_is_denied_once_the_interrupt_is_sent() {
        let (pauses, run_control) = pauses();
        pauses.pause(LEAD, PausedRole::Lead, pause());

        let mut parked = call(&pauses, CodexHookEvent::PreToolUse, LEAD);
        assert!(is_still_held(&mut parked).await);
        assert_eq!(run_control.took_effect.load(Ordering::SeqCst), 1);

        pauses.interrupt_sent(LEAD);
        assert_eq!(settled(parked).await, Some(paused_denial()));
        let after_the_interrupt = call(&pauses, CodexHookEvent::PreToolUse, LEAD);
        assert_eq!(settled(after_the_interrupt).await, Some(paused_denial()));

        assert!(pauses.resume(LEAD, None));
        let after_continue = call(&pauses, CodexHookEvent::PreToolUse, LEAD);
        assert_eq!(settled(after_continue).await, Some(CodexHookAnswer::Pass));
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_helper_call_is_allowed_on_continue_and_reads_the_words_after_it() {
        let (pauses, run_control) = pauses();
        pauses.pause(HELPER, PausedRole::Helper, pause());

        let mut first = call(&pauses, CodexHookEvent::PreToolUse, HELPER);
        let mut second = call(&pauses, CodexHookEvent::PreToolUse, HELPER);
        assert!(is_still_held(&mut first).await);
        assert!(is_still_held(&mut second).await);
        assert_eq!(run_control.took_effect.load(Ordering::SeqCst), 1);

        pauses.interrupt_sent(HELPER);
        assert!(is_still_held(&mut first).await);

        assert!(pauses.resume(HELPER, Some("check the tests first".to_owned())));
        assert_eq!(settled(first).await, Some(CodexHookAnswer::Pass));
        assert_eq!(settled(second).await, Some(CodexHookAnswer::Pass));
        let finished = call(&pauses, CodexHookEvent::PostToolUse, HELPER);
        assert_eq!(
            settled(finished).await,
            Some(CodexHookAnswer::Context {
                additional_context: "check the tests first".to_owned(),
            })
        );
        let finished_again = call(&pauses, CodexHookEvent::PostToolUse, HELPER);
        assert_eq!(settled(finished_again).await, Some(CodexHookAnswer::Pass));
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_call_ends_when_its_token_cancels_and_on_nothing_else() {
        let (pauses, _run_control) = pauses();
        pauses.pause(HELPER, PausedRole::Helper, pause());
        let token = CancellationToken::new();
        let mut held = tokio::spawn({
            let pauses = Arc::clone(&pauses);
            let token = token.clone();
            async move {
                let input = CodexHookInput {
                    event: CodexHookEvent::PreToolUse,
                    thread_id: HELPER.to_owned(),
                    session_id: None,
                    turn_id: None,
                    tool_name: None,
                    tool_use_id: None,
                    tool_input: None,
                    tool_response: None,
                    cwd: None,
                };
                pauses
                    .answer(&input, &token)
                    .await
                    .expect("the pauses never fail")
            }
        });
        assert!(is_still_held(&mut held).await);

        token.cancel();

        assert_eq!(settled(held).await, None);
        assert_eq!(pauses.thread_paused_for(&run_id()).as_deref(), Some(HELPER));
    }

    #[rstest]
    #[case::lead(LEAD, PausedRole::Lead)]
    #[case::helper(HELPER, PausedRole::Helper)]
    #[tokio::test(start_paused = true)]
    async fn a_pause_whose_run_ended_holds_nothing_and_lets_go(
        #[case] thread_id: &str,
        #[case] role: PausedRole,
    ) {
        let (pauses, run_control) = pauses();
        run_control.is_run_ended.store(true, Ordering::SeqCst);
        pauses.pause(thread_id, role, pause());

        let answered = call(&pauses, CodexHookEvent::PreToolUse, thread_id);

        assert_eq!(settled(answered).await, Some(CodexHookAnswer::Pass));
        assert_eq!(run_control.took_effect.load(Ordering::SeqCst), 0);
        assert_eq!(pauses.thread_paused_for(&run_id()), None);
    }
}
