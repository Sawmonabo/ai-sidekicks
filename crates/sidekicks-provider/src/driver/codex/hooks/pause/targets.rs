//! The helper a Codex collaboration call aims at, by the call's `target`, resolved as Codex
//! resolves it: a target that reads as a thread id names that thread; `/root` names the lead; a
//! path from `/` names the node there; any other reference names the node at the caller's path
//! joined with it, the lead's path being `/root`. A spawn or a wait names no helper. A call aimed
//! at a helper a pause holds, the person's or an interrupt's, is denied before the caller's own
//! hold, since a held call is later let go with no second check.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex run control pauses and continues runs through the pauses"
    )
)]

use std::error::Error;

use serde::Deserialize;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::error_description::describe_error;
use uuid::Uuid;

use super::CodexRunPauses;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::hooks::server::{CodexHookAnswer, CodexHookInput};
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::hook_pauses::{HELD_TARGET_REASON, PausedRole};
use crate::driver::session_messages::target_unread_reason;
use crate::port::agent_tree_lookup::AgentTreeLookup;

/// The tool Codex names a message to another agent by at its hooks.
pub(crate) const CODEX_SEND_MESSAGE_TOOL: &str = "collaborationsend_message";

/// The tool Codex names a follow-up task for another agent by at its hooks.
pub(crate) const CODEX_FOLLOWUP_TASK_TOOL: &str = "collaborationfollowup_task";

/// The tool Codex names an interrupt of another agent by at its hooks.
pub(crate) const CODEX_INTERRUPT_AGENT_TOOL: &str = "collaborationinterrupt_agent";

/// The path Codex gives the session's lead.
const ROOT_PATH: &str = "/root";

// The member of a collaboration call's input that names the agent it aims at.
#[derive(Deserialize)]
struct CollaborationCall {
    target: Option<String>,
}

// What a collaboration call's target names, before any read.
enum AimedTarget {
    Thread(String),
    Path(PathReference),
}

// A target read as a path in the session's agent tree.
enum PathReference {
    Absolute(String),
    Relative(String),
}

impl CodexRunPauses {
    /// Denies a collaboration call aimed at a helper a pause holds with [`HELD_TARGET_REASON`],
    /// and one whose target could not be read with the read's cause; `None` for any other call.
    /// A path is read from the agent tree only while a helper of the call's session is paused.
    pub(super) async fn answer_aimed_call(
        &self,
        input: &CodexHookInput,
    ) -> Option<CodexHookAnswer> {
        let thread_id = match aimed_target(input)? {
            AimedTarget::Thread(thread_id) => thread_id,
            AimedTarget::Path(reference) => {
                let run = self
                    .call_runs
                    .find_call_run(&input.thread_id, input.turn_id.as_deref())?;
                if !self.holds_helper_of(run.session_id) {
                    return None;
                }
                let lookup = self.agent_tree.port()?;
                match find_target_thread(lookup.as_ref(), run.session_id, input, reference).await {
                    Ok(thread_id) => thread_id?,
                    Err(error) => {
                        return Some(CodexHookAnswer::Deny {
                            reason: target_unread_reason(&describe_error(&*error)),
                        });
                    }
                }
            }
        };
        self.is_helper_held(&thread_id)
            .then(|| CodexHookAnswer::Deny {
                reason: HELD_TARGET_REASON.to_owned(),
            })
    }

    // Whether a pause holds the helper conversation `thread_id`; a pause outliving its run, which
    // the helper's own next call lets go, holds nothing. Run control is asked outside the lock.
    fn is_helper_held(&self, thread_id: &str) -> bool {
        let run_id = self
            .lock()
            .pauses
            .get(&thread_id.to_owned())
            .filter(|pause| pause.role() == PausedRole::Helper)
            .map(|pause| pause.detail().run_id);
        run_id.is_some_and(|run_id| self.run_control.is_run_live(&run_id))
    }

    // Whether a pause holds any helper of `session_id`.
    fn holds_helper_of(&self, session_id: SessionId) -> bool {
        self.lock()
            .pauses
            .find(|pause| pause.role() == PausedRole::Helper && *pause.session_id() == session_id)
            .is_some()
    }
}

// The target a call of one of the aimed tools names; `None` for any other tool, a target missing
// or empty, which Codex refuses itself, and the lead's path.
fn aimed_target(input: &CodexHookInput) -> Option<AimedTarget> {
    let tool_name = input.tool_name.as_deref()?;
    let is_aimed = [
        CODEX_SEND_MESSAGE_TOOL,
        CODEX_FOLLOWUP_TASK_TOOL,
        CODEX_INTERRUPT_AGENT_TOOL,
    ]
    .contains(&tool_name);
    if !is_aimed {
        return None;
    }
    let target = read_codex_object::<CollaborationCall>(input.tool_input.as_deref()?.get())?
        .target
        .filter(|target| !target.is_empty() && target != ROOT_PATH)?;
    if Uuid::parse_str(&target).is_ok() {
        return Some(AimedTarget::Thread(target));
    }
    Some(AimedTarget::Path(if target.starts_with('/') {
        PathReference::Absolute(target)
    } else {
        PathReference::Relative(target)
    }))
}

// The thread of the helper `reference` names in `session_id`, `None` where no node holds its
// path or the caller of a relative reference has no known path. Fails when a read fails.
async fn find_target_thread(
    lookup: &dyn AgentTreeLookup,
    session_id: SessionId,
    input: &CodexHookInput,
    reference: PathReference,
) -> Result<Option<String>, Box<dyn Error + Send + Sync>> {
    let path = match reference {
        PathReference::Absolute(path) => path,
        PathReference::Relative(reference) => {
            let caller_path = if input.session_id.as_deref() == Some(input.thread_id.as_str()) {
                ROOT_PATH.to_owned()
            } else {
                let caller = lookup
                    .helper_by_subagent_id(
                        session_id,
                        DESCRIPTOR.provider_id(),
                        input.thread_id.clone(),
                    )
                    .await?;
                let Some(caller_path) = caller.and_then(|caller| caller.provider_path) else {
                    return Ok(None);
                };
                caller_path
            };
            format!("{caller_path}/{reference}")
        }
    };
    Ok(lookup
        .helper_by_provider_path(session_id, path)
        .await?
        .map(|helper| helper.subagent_id))
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::sync::Arc;

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::agent::tree::ChildHandle;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_std::port_registration::PortRegistration;
    use tokio_util::sync::CancellationToken;

    use super::{CODEX_FOLLOWUP_TASK_TOOL, CODEX_INTERRUPT_AGENT_TOOL, CODEX_SEND_MESSAGE_TOOL};
    use crate::driver::codex::hooks::pause::tests::{pause, pauses_over};
    use crate::driver::codex::hooks::server::{
        CodexHookAnswer, CodexHookAnswerer, CodexHookEvent, CodexHookInput,
    };
    use crate::driver::hook_pauses::{HELD_TARGET_REASON, PausedRole};
    use crate::port::agent_tree_lookup::{AgentTreeHelper, AgentTreeLookup};

    const LEAD: &str = "0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b00";
    const CALLER: &str = "0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b01";
    const HELD_CHILD: &str = "0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b02";
    const RUNNING_CHILD: &str = "0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b03";

    /// The session's agent tree: the helper caller at `/root/caller`, under it the held child at
    /// `/root/caller/worker` and the running one at `/root/caller/other`.
    struct Tree;

    type Lookup<'a> = BoxFuture<'a, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>>;

    const NODES: [(&str, &str); 3] = [
        (CALLER, "/root/caller"),
        (HELD_CHILD, "/root/caller/worker"),
        (RUNNING_CHILD, "/root/caller/other"),
    ];

    fn node(found: Option<&(&str, &str)>) -> Option<AgentTreeHelper> {
        found.map(|(thread_id, path)| AgentTreeHelper {
            child_handle: ChildHandle::new(format!("child-{thread_id}")).expect("a handle"),
            subagent_id: (*thread_id).to_owned(),
            provider_path: Some((*path).to_owned()),
            own_run_id: RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a run id"),
            own_run_state: RunState::Running,
            own_run_stop_trigger: None,
        })
    }

    impl AgentTreeLookup for Tree {
        fn helper_by_subagent_id(
            &self,
            _session_id: SessionId,
            _provider_name: ProviderId,
            subagent_id: String,
        ) -> Lookup<'_> {
            let found = node(
                NODES
                    .iter()
                    .find(|(thread_id, _)| *thread_id == subagent_id),
            );
            async move { Ok(found) }.boxed()
        }

        fn helper_by_name(&self, _session_id: SessionId, _name: String) -> Lookup<'_> {
            async { Ok(None) }.boxed()
        }

        fn helper_by_provider_path(&self, _session_id: SessionId, path: String) -> Lookup<'_> {
            let found = node(NODES.iter().find(|(_, node_path)| *node_path == path));
            async move { Ok(found) }.boxed()
        }
    }

    // One pre-tool call of `tool_name` by the helper caller, its input naming `target`.
    fn aimed_call(tool_name: &str, target: &str) -> CodexHookInput {
        CodexHookInput {
            event: CodexHookEvent::PreToolUse,
            thread_id: CALLER.to_owned(),
            session_id: Some(LEAD.to_owned()),
            turn_id: Some("turn-1".to_owned()),
            tool_name: Some(tool_name.to_owned()),
            tool_use_id: Some("call-1".to_owned()),
            tool_input: Some(
                RawValue::from_string(json!({ "target": target, "message": "go on" }).to_string())
                    .expect("a JSON input"),
            ),
            tool_response: None,
            cwd: None,
        }
    }

    // Killed by the check removed (a held child's call passing), by every child denied (the
    // running child's call or a spawn or wait denied), and by a relative path read against the
    // lead's path (`worker` resolved to `/root/worker`, which no node holds). A paused child and
    // an interrupted one are the same pause on Codex, so one held child serves both.
    #[rstest]
    #[case::send_by_thread(CODEX_SEND_MESSAGE_TOOL, HELD_CHILD, true)]
    #[case::send_by_absolute_path(CODEX_SEND_MESSAGE_TOOL, "/root/caller/worker", true)]
    #[case::send_by_relative_path(CODEX_SEND_MESSAGE_TOOL, "worker", true)]
    #[case::followup_by_thread(CODEX_FOLLOWUP_TASK_TOOL, HELD_CHILD, true)]
    #[case::followup_by_absolute_path(CODEX_FOLLOWUP_TASK_TOOL, "/root/caller/worker", true)]
    #[case::followup_by_relative_path(CODEX_FOLLOWUP_TASK_TOOL, "worker", true)]
    #[case::interrupt_by_thread(CODEX_INTERRUPT_AGENT_TOOL, HELD_CHILD, true)]
    #[case::interrupt_by_absolute_path(CODEX_INTERRUPT_AGENT_TOOL, "/root/caller/worker", true)]
    #[case::interrupt_by_relative_path(CODEX_INTERRUPT_AGENT_TOOL, "worker", true)]
    #[case::send_to_a_running_child_by_thread(CODEX_SEND_MESSAGE_TOOL, RUNNING_CHILD, false)]
    #[case::send_to_a_running_child_by_path(CODEX_SEND_MESSAGE_TOOL, "other", false)]
    #[case::interrupt_of_a_running_child(CODEX_INTERRUPT_AGENT_TOOL, "/root/caller/other", false)]
    #[case::spawn("collaborationspawn_agent", "worker", false)]
    #[case::wait("collaborationwait_agent", HELD_CHILD, false)]
    #[tokio::test(start_paused = true)]
    async fn a_collaboration_call_aimed_at_a_held_child_is_denied(
        #[case] tool_name: &str,
        #[case] target: &str,
        #[case] is_denied: bool,
    ) {
        let agent_tree: Arc<PortRegistration<Arc<dyn AgentTreeLookup>>> =
            Arc::new(PortRegistration::new("agent tree lookup"));
        agent_tree
            .register(Arc::new(Tree))
            .expect("the first registration");
        let (pauses, _run_control) = pauses_over(agent_tree);
        pauses.pause(HELD_CHILD, PausedRole::Helper, pause());

        let answer = pauses
            .answer(&aimed_call(tool_name, target), &CancellationToken::new())
            .await
            .expect("the pauses never fail");

        let expected = is_denied.then(|| CodexHookAnswer::Deny {
            reason: HELD_TARGET_REASON.to_owned(),
        });
        assert_eq!(answer, expected);
    }
}
