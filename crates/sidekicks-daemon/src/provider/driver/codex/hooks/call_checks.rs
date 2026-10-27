//! The daemon's own checks on a tool call at Codex's pre-tool hook, answered ahead of the pauses:
//!
//! - a command that starts a provider's background work is refused at every level, the levels
//!   where Codex never asks included, read through `sh -c` and `eval` as the asks are;
//! - a call of a run at its token limit or its helper turn cap is denied, so the run stops there
//!   and reports what it has;
//! - a command, a file change or a tool server's call on a subject whose rule the session made and
//!   the person revoked is held for a card, since Codex keeps an allow for the conversation and has
//!   no verb to drop it; a change is held when any file it touches is such a subject. The card is
//!   the approval pipeline's own, raised under a `hook:` request id, and its answer lets the call
//!   run or refuses it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::approval::RememberedScopeKind;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::resolve_path_against;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::background_work::{BackgroundWorkForms, refuse_background_work};
use crate::codex::hooks::server::{
    CodexHookAnswer, CodexHookAnswerer, CodexHookEvent, CodexHookInput,
};
use crate::codex::session::errors::CodexError;
use crate::codex::transport::connection::read_codex_object;
use crate::mcp::tool_name::TOOL_SERVER_TOOL_PREFIX;
use crate::port::permission_ask::{
    PermissionAskPort, ProviderAskAction, ProviderPermissionAnswer, ProviderPermissionAsk,
    ProviderPermissionAskWithdrawal,
};
use crate::port::registration::PortRegistration;
use crate::port::session_rules::SessionRulePort;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_policy::shell_commands::unwrap_shell_command_line;
use sidekicks_std::mutex_lock::lock;

/// The tool Codex names a shell command by at its hooks.
const CODEX_HOOK_SHELL_TOOL: &str = "Bash";

/// The tool Codex names a file change by at its hooks.
const CODEX_HOOK_PATCH_TOOL: &str = "apply_patch";

/// The headers of a patch's lines that name a file it adds, changes, deletes or moves to.
const PATCH_FILE_HEADERS: [&str; 4] = [
    "*** Add File: ",
    "*** Update File: ",
    "*** Delete File: ",
    "*** Move to: ",
];

/// The prefix of the request id a held call's card is raised under, which no Codex request id has.
const HOOK_REQUEST_ID_PREFIX: &str = "hook:";

/// What the agent reads when its held call is declined with no reason given.
const HELD_CALL_DECLINED_REASON: &str = "The person declined this call.";

/// What the agent reads when its session closed while its call was held.
const SESSION_CLOSED_REASON: &str = "The session closed before anyone answered.";

/// The run a conversation's tool call belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CodexHookCallRun {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
}

/// What the checks read about the run a call belongs to.
pub(crate) trait CodexCallRuns: Send + Sync {
    /// The run a call in `thread_id`'s turn `turn_id` belongs to, or `None` when none is known.
    fn find_call_run(&self, thread_id: &str, turn_id: Option<&str>) -> Option<CodexHookCallRun>;

    /// The reason `run`'s next call is denied when it reached its token limit or, on a helper, its
    /// turn cap; `None` while it may go on.
    fn read_limit_refusal(&self, run: &CodexHookCallRun) -> Option<String>;
}

/// What the checks read the rules from, raise a held call's card through and read lines with.
pub(crate) struct CodexCallChecksDependencies {
    /// The approval pipeline's intake, where a held call's card is raised.
    pub(crate) permission_asks: Arc<PortRegistration<Arc<dyn PermissionAskPort>>>,
    /// The rules in force on a session, and those revoked.
    pub(crate) session_rules: Arc<PortRegistration<Arc<dyn SessionRulePort>>>,
    /// The daemon-wide bound every command line is read within.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// Every provider's background work, which no call's command line may start.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The run each call belongs to, and its limits.
    pub(crate) runs: Arc<dyn CodexCallRuns>,
    /// The driver's tasks, which its shutdown waits for; a held call's card is taken back on one.
    pub(crate) tasks: TaskTracker,
}

/// A call held for its card.
struct HeldCall {
    session_id: SessionId,
    answer: oneshot::Sender<CodexHookAnswer>,
}

/// The pre-tool hook's checks, answered ahead of the pauses, and the calls they hold for a card.
pub(crate) struct CodexCallChecks {
    dependencies: CodexCallChecksDependencies,
    /// By request id; never held across an await.
    held_by_request_id: Mutex<HashMap<String, HeldCall>>,
}

impl CodexCallChecks {
    /// The checks over `dependencies`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex driver puts the call checks first among its hook answerers"
        )
    )]
    pub(crate) fn new(dependencies: CodexCallChecksDependencies) -> Self {
        Self {
            dependencies,
            held_by_request_id: Mutex::new(HashMap::new()),
        }
    }

    /// Hands a held call its card's answer: an allow lets the call run, a refusal denies it with
    /// the person's reason. Answers whether `request_id` named a held call; a Codex request id
    /// names none.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex driver's answer to a request settles a held call through it"
        )
    )]
    pub(crate) fn settle(&self, request_id: &str, answer: &ProviderPermissionAnswer) -> bool {
        let Some(held) = self.lock().remove(request_id) else {
            return false;
        };
        let hook_answer = match answer {
            ProviderPermissionAnswer::Allow { .. } => CodexHookAnswer::Pass,
            ProviderPermissionAnswer::Refuse { reason, .. } => CodexHookAnswer::Deny {
                reason: reason
                    .clone()
                    .unwrap_or_else(|| HELD_CALL_DECLINED_REASON.to_owned()),
            },
        };
        // A call that stopped waiting withdrew its card already.
        let _unheard = held.answer.send(hook_answer);
        true
    }

    /// Refuses the calls a closed session held, whose cards are canceled with its runs.
    #[expect(
        dead_code,
        reason = "the Codex session's close refuses the calls its checks hold"
    )]
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let refused: Vec<HeldCall> = {
            let mut held_calls = self.lock();
            let request_ids: Vec<String> = held_calls
                .iter()
                .filter(|(_, held)| held.session_id == session_id)
                .map(|(request_id, _)| request_id.clone())
                .collect();
            request_ids
                .iter()
                .filter_map(|request_id| held_calls.remove(request_id))
                .collect()
        };
        for held in refused {
            let _unheard = held.answer.send(CodexHookAnswer::Deny {
                reason: SESSION_CLOSED_REASON.to_owned(),
            });
        }
    }

    // Answers a pre-tool call: a refused background command, a run at its limit, a held call's
    // answer, or `None` to let the next answerer answer.
    async fn check_call(
        &self,
        input: &CodexHookInput,
    ) -> Result<Option<CodexHookAnswer>, CodexError> {
        let tool_input = input
            .tool_input
            .as_deref()
            .and_then(|raw| read_codex_object::<HookToolInput>(raw.get()));
        let command = tool_input
            .and_then(|tool_input| tool_input.command)
            .and_then(|command| match command {
                Value::String(command) => Some(command),
                Value::Null
                | Value::Bool(_)
                | Value::Number(_)
                | Value::Array(_)
                | Value::Object(_) => None,
            })
            .filter(|command| !command.is_empty());
        let Some(action) = read_hook_action(input, command.as_deref()) else {
            return Ok(None);
        };
        if let (ProviderAskAction::Command { .. }, Some(line)) = (&action, command)
            && let Some(reason) = self.refuse_background_work(line).await
        {
            return Ok(Some(CodexHookAnswer::Deny { reason }));
        }
        let runs = &self.dependencies.runs;
        let Some(run) = runs.find_call_run(&input.thread_id, input.turn_id.as_deref()) else {
            return Ok(None);
        };
        if let Some(reason) = runs.read_limit_refusal(&run) {
            return Ok(Some(CodexHookAnswer::Deny { reason }));
        }
        let (Some(asks), Some(rules)) = (
            self.dependencies.permission_asks.port(),
            self.dependencies.session_rules.port(),
        ) else {
            return Ok(None);
        };
        if !self
            .is_revoked_subject(rules.as_ref(), run.session_id, &action)
            .await?
        {
            return Ok(None);
        }
        self.hold_call(Arc::clone(asks), input, run, action).await
    }

    // The line is read once, on the bound's blocking thread, its `-c` and `eval` strings with it.
    async fn refuse_background_work(&self, line: String) -> Option<String> {
        let background_work = Arc::clone(&self.dependencies.background_work);
        self.dependencies
            .shell_lines
            .read(line.len(), move |reader| {
                let reading = reader.read(&line);
                refuse_background_work(&background_work, reader, &reading)
            })
            .await
            .expect("a shell-line read never panics, and a panic ends the daemon")
            .map(str::to_owned)
    }

    // Each file of a change is looked up on its own, since a rule names one file.
    async fn is_revoked_subject(
        &self,
        rules: &dyn SessionRulePort,
        session_id: SessionId,
        action: &ProviderAskAction,
    ) -> Result<bool, CodexError> {
        let subjects = match action {
            ProviderAskAction::FileChange { paths } => paths
                .iter()
                .map(|path| ProviderAskAction::FileChange {
                    paths: vec![path.clone()],
                })
                .collect(),
            ProviderAskAction::Command { .. }
            | ProviderAskAction::CommandInput { .. }
            | ProviderAskAction::FileRead { .. }
            | ProviderAskAction::Network { .. }
            | ProviderAskAction::Tool { .. } => vec![action.clone()],
        };
        for subject in subjects {
            let revoked = rules
                .find_revoked_rule(session_id, subject)
                .await
                .map_err(|cause| CodexError::PortFailed {
                    port: "session rule",
                    cause,
                })?;
            if revoked.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    // Holds the call until its card is answered. A call that stops waiting first takes its card
    // back, through the withdrawal its dropped hold makes.
    async fn hold_call(
        &self,
        asks: Arc<dyn PermissionAskPort>,
        input: &CodexHookInput,
        run: CodexHookCallRun,
        action: ProviderAskAction,
    ) -> Result<Option<CodexHookAnswer>, CodexError> {
        let call_id = input
            .tool_use_id
            .clone()
            // A call Codex named no id for is held under a minted one.
            .unwrap_or_else(|| mint_uuid_v7().to_string());
        let request_id = format!("{HOOK_REQUEST_ID_PREFIX}{call_id}");
        let (answer, answered) = oneshot::channel();
        self.lock().insert(
            request_id.clone(),
            HeldCall {
                session_id: run.session_id,
                answer,
            },
        );
        let hold = HeldCallWithdrawal {
            checks: self,
            asks: Arc::clone(&asks),
            session_id: run.session_id,
            request_id: request_id.clone(),
        };
        let tool_input = input
            .tool_input
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
            .unwrap_or(Value::Null);
        let taken = asks
            .take_ask(ProviderPermissionAsk {
                session_id: run.session_id,
                run_id: run.run_id,
                request_id: request_id.clone(),
                tool_name: input
                    .tool_name
                    .clone()
                    .unwrap_or_else(|| CODEX_HOOK_SHELL_TOOL.to_owned()),
                input: tool_input,
                action,
                // Its answer reaches the hook alone, so a rule on it is the session's, which the
                // daemon keeps; no project file is written from it.
                rule_scopes: vec![RememberedScopeKind::Session],
                is_provider_flagged: false,
                is_sent_by_level_rule: false,
                tool_call_id: input.tool_use_id.clone(),
                prompt: None,
                correction_of: None,
            })
            .await;
        if let Err(cause) = taken {
            // No card was raised, so none is withdrawn.
            self.lock().remove(&request_id);
            return Err(CodexError::PortFailed {
                port: "permission ask",
                cause,
            });
        }
        let answer = answered.await.ok();
        drop(hold);
        Ok(answer)
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, HeldCall>> {
        lock(&self.held_by_request_id)
    }
}

impl CodexHookAnswerer for CodexCallChecks {
    /// A pre-tool call is refused, denied at its run's limit, held, or let through to the next
    /// answerer; a post-tool call always goes on. Fails when the rules could not be read or the
    /// card could not be raised.
    fn answer<'a>(
        &'a self,
        input: &'a CodexHookInput,
        _token: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Option<CodexHookAnswer>, CodexError>> {
        match input.event {
            CodexHookEvent::PreToolUse => self.check_call(input).boxed(),
            CodexHookEvent::PostToolUse => async { Ok(None) }.boxed(),
        }
    }
}

/// A held call's card, taken back when the call stops waiting before its answer: the dispatch
/// drops a canceled call's answer, and this hold with it.
struct HeldCallWithdrawal<'checks> {
    checks: &'checks CodexCallChecks,
    asks: Arc<dyn PermissionAskPort>,
    session_id: SessionId,
    request_id: String,
}

impl Drop for HeldCallWithdrawal<'_> {
    fn drop(&mut self) {
        // An answered or forgotten call left the map already, and its card is settled.
        if self.checks.lock().remove(&self.request_id).is_none() {
            return;
        }
        let asks = Arc::clone(&self.asks);
        let withdrawal = ProviderPermissionAskWithdrawal {
            session_id: self.session_id,
            request_id: std::mem::take(&mut self.request_id),
        };
        self.checks.dependencies.tasks.spawn(async move {
            if let Err(error) = asks.withdraw_ask(withdrawal).await {
                tracing::warn!(
                    error = &*error as &(dyn std::error::Error + 'static),
                    "the card of a Codex hook call that stopped waiting could not be withdrawn"
                );
            }
        });
    }
}

/// The member of a hooked call's input the checks read.
#[derive(Deserialize)]
struct HookToolInput {
    command: Option<Value>,
}

// What a hooked call would do: a command as the line its shell runs, a patch's files resolved
// against the call's folder, or a tool server's tool by its hook name; any other tool is not held.
fn read_hook_action(input: &CodexHookInput, command: Option<&str>) -> Option<ProviderAskAction> {
    let tool_name = input.tool_name.as_deref()?;
    if tool_name == CODEX_HOOK_SHELL_TOOL {
        return command.map(|command| ProviderAskAction::Command {
            command: unwrap_shell_command_line(command).into_owned(),
        });
    }
    if tool_name == CODEX_HOOK_PATCH_TOOL {
        let base = input.cwd.as_deref().unwrap_or("/");
        let paths: Vec<String> = command
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                PATCH_FILE_HEADERS
                    .iter()
                    .find_map(|header| line.strip_prefix(header))
            })
            .filter(|named| !named.is_empty())
            // A name that cannot be resolved keeps its own words, so its subject is still looked
            // up rather than the change let through.
            .map(|named| resolve_path_against(base, named).unwrap_or_else(|_| named.to_owned()))
            .collect();
        return (!paths.is_empty()).then_some(ProviderAskAction::FileChange { paths });
    }
    tool_name
        .starts_with(TOOL_SERVER_TOOL_PREFIX)
        .then(|| ProviderAskAction::Tool {
            tool_name: tool_name.to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    use super::{CodexCallChecks, CodexCallChecksDependencies, CodexCallRuns, CodexHookCallRun};
    use crate::background_work::BackgroundWorkForms;
    use crate::codex::hooks::server::{
        CodexHookAnswer, CodexHookCall, CodexHookDispatch, CodexHookEvent,
    };
    use crate::driver::PROVIDERS;
    use crate::port::permission_ask::{
        PermissionAskPort, ProviderAskAction, ProviderPermissionAnswer, ProviderPermissionAsk,
        ProviderPermissionAskWithdrawal,
    };
    use crate::port::registration::PortRegistration;
    use crate::port::session_rules::SessionRulePort;
    use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
    use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;

    type PortFailure = Box<dyn Error + Send + Sync>;

    /// Every call belongs to one live run, below its limits.
    struct OneRun(CodexHookCallRun);

    impl CodexCallRuns for OneRun {
        fn find_call_run(
            &self,
            _thread_id: &str,
            _turn_id: Option<&str>,
        ) -> Option<CodexHookCallRun> {
            Some(self.0)
        }

        fn read_limit_refusal(&self, _run: &CodexHookCallRun) -> Option<String> {
            None
        }
    }

    /// Holds `git push` revoked and nothing else.
    struct RevokedPush;

    impl SessionRulePort for RevokedPush {
        fn read_session_rules(
            &self,
            _session_id: SessionId,
        ) -> BoxFuture<'_, Result<Vec<ProviderAskRule>, PortFailure>> {
            async { Ok(Vec::new()) }.boxed()
        }

        fn find_revoked_rule(
            &self,
            _session_id: SessionId,
            action: ProviderAskAction,
        ) -> BoxFuture<'_, Result<Option<ProviderAskRule>, PortFailure>> {
            let revoked = (action
                == ProviderAskAction::Command {
                    command: "git push".to_owned(),
                })
            .then(|| ProviderAskRule {
                kind: RememberedScopeKind::Session,
                sense: RememberedRuleSense::Allow,
                action: ProviderAskActionKind::Command,
                subject: "git push".to_owned(),
            });
            async move { Ok(revoked) }.boxed()
        }
    }

    /// Records the cards raised and taken back, telling a waiter at each.
    #[derive(Default)]
    struct RecordingAsks {
        taken: Mutex<Vec<ProviderPermissionAsk>>,
        withdrawn: Mutex<Vec<ProviderPermissionAskWithdrawal>>,
        changed: Notify,
    }

    impl PermissionAskPort for RecordingAsks {
        fn take_ask(&self, ask: ProviderPermissionAsk) -> BoxFuture<'_, Result<(), PortFailure>> {
            self.taken
                .lock()
                .expect("the record is not poisoned")
                .push(ask);
            self.changed.notify_one();
            async { Ok(()) }.boxed()
        }

        fn withdraw_ask(
            &self,
            withdrawal: ProviderPermissionAskWithdrawal,
        ) -> BoxFuture<'_, Result<(), PortFailure>> {
            self.withdrawn
                .lock()
                .expect("the record is not poisoned")
                .push(withdrawal);
            self.changed.notify_one();
            async { Ok(()) }.boxed()
        }
    }

    fn shell_call(call_id: &str) -> CodexHookCall {
        let Value::Object(arguments) = json!({
            "hook_event_name": "PreToolUse",
            "turn_id": "turn-1",
            "tool_name": "Bash",
            "tool_use_id": call_id,
            "tool_input": { "command": "/bin/zsh -lc 'git push'" },
            "cwd": "/work",
        }) else {
            panic!("the arguments are an object");
        };
        CodexHookCall {
            arguments,
            meta: Map::from_iter([("threadId".to_owned(), json!("thread-1"))]),
        }
    }

    // Killed by answering a revoked subject's call without holding it, by settling it without the
    // card's answer, and by a canceled call leaving its card raised.
    #[tokio::test(start_paused = true)]
    async fn a_call_on_a_revoked_subject_is_held_until_its_card_is_answered() {
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let asks = Arc::new(RecordingAsks::default());
        let permission_asks = Arc::new(PortRegistration::new("permission ask"));
        let ask_port: Arc<dyn PermissionAskPort> = asks.clone();
        assert!(permission_asks.register(ask_port).is_ok());
        let session_rules = Arc::new(PortRegistration::new("session rule"));
        let rule_port: Arc<dyn SessionRulePort> = Arc::new(RevokedPush);
        assert!(session_rules.register(rule_port).is_ok());
        let checks = Arc::new(CodexCallChecks::new(CodexCallChecksDependencies {
            permission_asks,
            session_rules,
            shell_lines: Arc::new(ShellLineReadingBound::new(4096)),
            background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
            runs: Arc::new(OneRun(CodexHookCallRun { session_id, run_id })),
            tasks: TaskTracker::new(),
        }));
        let dispatch = Arc::new(CodexHookDispatch::new(vec![checks.clone()]));
        let answer = |call_id: &'static str, token: CancellationToken| {
            let dispatch = Arc::clone(&dispatch);
            tokio::spawn(async move {
                dispatch
                    .answer(CodexHookEvent::PreToolUse, shell_call(call_id), &token)
                    .await
            })
        };

        let held = answer("call-1", CancellationToken::new());
        asks.changed.notified().await;
        let card = asks.taken.lock().expect("the record is not poisoned")[0].clone();
        assert_eq!(card.request_id, "hook:call-1");
        assert_eq!(card.run_id, run_id);
        tokio::task::yield_now().await;
        assert!(!held.is_finished(), "the call waits for its card's answer");

        let allow = ProviderPermissionAnswer::Allow {
            correction: None,
            made_rule: None,
            answered_by_rule: None,
        };
        assert!(checks.settle("hook:call-1", &allow));
        assert_eq!(
            held.await.expect("the call's task ends"),
            Some(CodexHookAnswer::Pass)
        );

        let token = CancellationToken::new();
        let abandoned = answer("call-2", token.clone());
        asks.changed.notified().await;
        token.cancel();
        assert_eq!(abandoned.await.expect("the call's task ends"), None);
        asks.changed.notified().await;
        let withdrawn = asks
            .withdrawn
            .lock()
            .expect("the record is not poisoned")
            .clone();
        assert_eq!(
            withdrawn,
            vec![ProviderPermissionAskWithdrawal {
                session_id,
                request_id: "hook:call-2".to_owned(),
            }]
        );
        assert!(!checks.settle("hook:call-2", &allow));
    }
}
