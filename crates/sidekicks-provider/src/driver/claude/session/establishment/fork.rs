//! A fork of a session's conversation at a recorded turn, adopted in place of the process it
//! forks: the conversation is cut at the turn's end and the next turn's prompt dropped, the fork
//! brought up on the predecessor's legs but for a tool-server status leg of its own, the session's
//! binding pointed at it, and the predecessor stopped. A fork that cannot be brought up or adopted
//! leaves the predecessor the session's.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use super::context::ClaudeSpawnContextError;
use super::{
    ClaudeCallbackBinding, ClaudeEstablishmentError, ClaudeModelCheck, ClaudeSessionEstablishment,
    ClaudeSessionStart,
};
use crate::driver::claude::run::start::claude_session_unavailable;
use crate::driver::claude::session::conversation_file::{
    conversation_file_of, read_claude_conversation_outline,
};
use crate::driver::claude::session::errors::ClaudeSessionUnavailableReason;
use crate::driver::claude::session::state::{ClaudeUsageEstablishment, LiveClaudeSession};
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::contract::error::{DriverError, bound_failure_detail};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::driver::session_control::{MoveSessionToForkParams, MoveSessionToForkResult};
use crate::left_conversations::LeftConversation;
use crate::runtime_binding::resume::ResumeFunctionLegs;
use crate::runtime_binding::store::{RuntimeBindingRebind, mint_runtime_binding_id};

impl ClaudeSessionEstablishment {
    /// Forks `predecessor`'s conversation at the turn `params` names and moves the session onto
    /// the fork, pointing its binding there; the predecessor runs on until the fork is adopted,
    /// then is stopped. A fork Claude Code refuses, or one that cannot be adopted, answers
    /// `Degraded` with the predecessor still the session's; fails `NoLiveSession` when the
    /// predecessor is no longer the session's live process.
    pub(crate) async fn fork(
        &self,
        params: MoveSessionToForkParams,
        predecessor: Arc<LiveClaudeSession>,
    ) -> Result<MoveSessionToForkResult, DriverError> {
        let session_id = params.session_id;
        let claim = self.slots.claim_rewind(&predecessor).ok_or_else(|| {
            claude_session_unavailable(
                ClaudeSessionUnavailableReason::NoLiveSession,
                session_id,
                None,
            )
        })?;
        let (resume_at_message_uuid, dropped_turn_prompt_uuid) =
            match self.read_fork_point(&predecessor, params.position).await {
                Ok(point) => point,
                Err(reason) => return Ok(degraded("rewind-refused", &reason)),
            };
        // The session's bound as it stands at the fork's bring-up, as every spawn reads it.
        let step_bound = match self.read_step_bound(&predecessor).await {
            Ok(step_bound) => step_bound,
            Err(error) => return Ok(degraded("rewind-adoption-failed", &describe_error(&error))),
        };
        // The fork reports its tool servers on a leg of its own, under a binding minted for it,
        // never on the predecessor's, which ends with the predecessor.
        let fork_legs = match self.open_fork_legs(session_id).await {
            Ok(fork_legs) => fork_legs,
            Err(error) => {
                return Ok(degraded(
                    "rewind-adoption-failed",
                    &describe_error(error.as_ref()),
                ));
            }
        };
        let settings = lock(&predecessor.settings).clone();
        // The predecessor's own legs, at the level, model, advisor and style it runs with now.
        let legs = ClaudeSpawnBoundLegs {
            execution_posture: settings.execution_posture.clone(),
            model: settings.running_model.clone(),
            advisor: settings.advisor.clone(),
            output_style: settings.output_style.clone(),
            on_mcp_server_status: fork_legs.on_mcp_server_status,
            ..predecessor.spawn_bound_legs.clone()
        };
        let forked_provider_session_id = mint_uuid_v7().to_string();
        let start = ClaudeSessionStart {
            claim,
            agent_id: predecessor.agent_id,
            provider_session_id: forked_provider_session_id.clone(),
            conversation: ClaudeConversationStart::Fork {
                resume_handle: predecessor.provider_session_id.clone(),
                forked_provider_session_id: forked_provider_session_id.clone(),
                resume_at_message_uuid,
                dropped_turn_prompt_uuid,
            },
            legs,
            callback_tools: ClaudeCallbackBinding::Shared(Arc::clone(
                &predecessor.callback_tool_binding,
            )),
            provider_account_id: predecessor.admitted_provider_account_id.clone(),
            session_mode: settings.session_mode,
            output_speed: settings.applied_output_speed.clone(),
            // Metered on from the predecessor's thread, the only one its usage was reported under.
            establishment: ClaudeUsageEstablishment::Resume {
                prior_emitted_thread_id: predecessor.provider_session_id.clone(),
            },
            command_choices: predecessor.command_choices.clone(),
            spawn_binding: predecessor.spawn_binding.clone(),
            model_check: ClaudeModelCheck::Unchecked,
            ultracode: settings.ultracode_requested,
            step_bound,
            resumed_binding_id: None,
            requested_spawn: predecessor.requested_spawn.clone(),
        };
        let rebind = |resume_handle: &str, left: Vec<LeftConversation>| RuntimeBindingRebind {
            binding_id: params.binding_id.clone(),
            resume_handle: resume_handle.to_owned(),
            left_conversations: left,
        };
        let adopted = self
            .bring_up_and(start, async |_live| {
                // Durable before the predecessor goes, so a restart of the daemon resumes the fork.
                self.rebind(rebind(
                    &forked_provider_session_id,
                    vec![LeftConversation {
                        session_id,
                        provider_account_id: predecessor.admitted_provider_account_id.clone(),
                        conversation_id: predecessor.provider_session_id.clone(),
                    }],
                ))
                .await
            })
            .await;
        match adopted {
            Ok(_) => {
                self.release_superseded(&predecessor).await;
                Ok(MoveSessionToForkResult::Applied {
                    session_position: params.position,
                })
            }
            // A close took the slot after the binding moved: it goes back to the conversation the
            // session keeps, so a later resume opens that one.
            Err(ClaudeEstablishmentError::Closed) => {
                let back = self
                    .rebind(rebind(
                        &predecessor.provider_session_id,
                        vec![LeftConversation {
                            session_id,
                            provider_account_id: predecessor.admitted_provider_account_id.clone(),
                            conversation_id: forked_provider_session_id.clone(),
                        }],
                    ))
                    .await;
                let reason = match back {
                    Ok(()) => ClaudeEstablishmentError::Closed.to_string(),
                    Err(error) => format!("{}; {error}", ClaudeEstablishmentError::Closed),
                };
                Ok(degraded("rewind-adoption-failed", &reason))
            }
            Err(error) => Ok(degraded("rewind-adoption-failed", &error.to_string())),
        }
    }

    // The predecessor a fork replaced: the run whose turn it held ends failed, its routes, waits
    // and messages go with it, and it is stopped at once, so neither its running turn nor what it
    // queued writes into the conversation it leaves; the presses its bindings held are let go.
    async fn release_superseded(&self, predecessor: &LiveClaudeSession) {
        let session_id = predecessor.session_id;
        if let Some(lead) = self.routes.lead_run_on(session_id) {
            self.task_services
                .cuts
                .fail_superseded_run(predecessor, lead.run_id, lead.binding_id);
            self.routes.forget_run(lead.run_id);
        }
        self.routes.retire_run_routes(session_id);
        self.routes.retire_child_routes(session_id);
        self.task_services
            .settlement
            .pending_compactions
            .release_binding(&session_id.to_string());
        lock(&self.prompts).forget_session(session_id);
        predecessor.channel.terminate().await;
        predecessor.release_served_presses(&self.sources.ports.reviewer_denials);
    }

    // The session's step bound as the daemon resolves it now, on the account the predecessor runs
    // on.
    async fn read_step_bound(
        &self,
        predecessor: &LiveClaudeSession,
    ) -> Result<Option<SafeInt<1>>, ClaudeEstablishmentError> {
        let context = self
            .sources
            .ports
            .spawn_contexts
            .require_port()?
            .resolve_spawn_context(
                predecessor.session_id,
                predecessor.admitted_provider_account_id.clone(),
            )
            .await
            .map_err(ClaudeSpawnContextError::Place)?;
        Ok(context.step_bound)
    }

    // The legs the session directory answers for a fork of `session_id` under a binding minted
    // for it. Fails as the directory is not registered or cannot answer them.
    async fn open_fork_legs(
        &self,
        session_id: SessionId,
    ) -> Result<ResumeFunctionLegs, Box<dyn Error + Send + Sync>> {
        let listener = self.sources.ports.session_relaunched.require_port()?;
        listener
            .open_relaunch_legs(session_id, mint_runtime_binding_id())
            .await
    }

    // Points the session's binding at the conversation it moved onto.
    async fn rebind(&self, rebind: RuntimeBindingRebind) -> Result<(), ClaudeEstablishmentError> {
        self.sources
            .runtime_bindings
            .rebind(rebind)
            .await
            .map_err(ClaudeEstablishmentError::Rebind)
    }

    // The entry a fork at `position` keeps the conversation up to, and the prompt of the turn it
    // discards; the reason in words where the conversation has no such turns.
    async fn read_fork_point(
        &self,
        predecessor: &LiveClaudeSession,
        position: SafeInt<0>,
    ) -> Result<(String, String), String> {
        let handle = &predecessor.provider_session_id;
        let outline =
            match conversation_file_of(&predecessor.spawn_bound_legs.spawn_environment, handle)
                .await
            {
                Ok(Some(file)) => {
                    read_claude_conversation_outline(&file)
                        .await
                        .map_err(|error| {
                            format!("The conversation {handle} could not be read: {error}")
                        })?
                }
                Ok(None) => return Err(format!("The conversation {handle} has no file.")),
                Err(error) => {
                    return Err(format!(
                        "The conversation {handle} could not be found: {error}"
                    ));
                }
            };
        let kept = usize::try_from(position.get()).unwrap_or(usize::MAX);
        let resume_at = kept
            .checked_sub(1)
            .and_then(|index| outline.turn_end_uuids.get(index));
        let dropped = outline
            .prompt_uuids
            .get(kept)
            .filter(|uuid| !uuid.is_empty());
        match (resume_at, dropped) {
            (Some(resume_at), Some(dropped)) => Ok((resume_at.clone(), dropped.clone())),
            _ => Err(format!(
                "Position {kept} names no turn of conversation {handle} with a later turn to \
                 discard."
            )),
        }
    }
}

// A fork answered by its fallback, `kind` leading Claude Code's or the daemon's words.
fn degraded(kind: &str, reason: &str) -> MoveSessionToForkResult {
    let detail = bound_failure_detail(reason, UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone());
    MoveSessionToForkResult::Degraded {
        fallback_action: FreeFormText::new(format!("{kind}: {}", detail.as_str())).ok(),
    }
}
