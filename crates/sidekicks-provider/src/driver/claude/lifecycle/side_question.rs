//! A side question on Claude Code: the copy of the conversation its one-turn process runs on, the
//! live process's own or a session at rest's from its resume material, locked down with the
//! person's own deny rules when another session asks, and the ask itself.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::ready;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{ClaudeDriver, ClaudeSessionParts};
use crate::driver::claude::session::controls::{
    ClaudeCopyComposition, ClaudeOneTurnReach, ClaudeSideQuestionCopy, claude_full_model_id,
    without_credential_prompts,
};
use crate::driver::claude::session::conversation_home::read_claude_conversation_home;
use crate::driver::claude::session::establishment::context::resolve_claude_spawn_context;
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSpawnSources;
use crate::driver::claude::session::rules::deny_list::read_claude_deny_list;
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::spawn::launch::initialize_reply::read_claude_initialize_declaration;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::claude::spawn::legs::{
    ClaudeSpawnLegServices, ClaudeSpawnLegsRequest, build_claude_spawn_bound_legs,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{
    AskSideQuestionParams, ResumeSessionParams, SideQuestionPurpose,
};

impl ClaudeDriver {
    /// Asks a side question on a copy of the conversation: the live process's own, else the one
    /// the session's resume material names, locked down when another session asks; resolves to
    /// its answer once it is answered. Fails `NoLiveSession` for a session at rest asked with no
    /// resume material, and as the person's deny rules cannot be read or the question's turn
    /// fails.
    pub(crate) async fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> Result<Option<FreeFormText<{ usize::MAX }>>, DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        let copy = self.compose_copy(parts, session_id, params.resume)?;
        let copy = match params.purpose {
            SideQuestionPurpose::Person => copy,
            SideQuestionPurpose::SessionAsk => lock_down(copy, Arc::clone(&self.sources)).boxed(),
        };
        let hold = parts
            .establishment
            .task_services
            .idle_sleep
            .hold_side_question(session_id);
        parts
            .session_controls
            .ask_side_question(
                session_id,
                params.purpose,
                params.binding_id,
                params.side_question_id,
                params.question,
                copy,
                hold,
            )
            .await
            .map(Some)
    }

    /// The copy of `session_id`'s conversation a one-turn process runs on: the live process's own,
    /// else the one `resume` names, composed once awaited. Fails `NoLiveSession` for a session at
    /// rest with no resume material.
    pub(crate) fn compose_copy(
        &self,
        parts: &ClaudeSessionParts,
        session_id: SessionId,
        resume: Option<ResumeSessionParams>,
    ) -> Result<ClaudeCopyComposition, DriverError> {
        Ok(match parts.run_start.live_session(session_id) {
            Ok(live) => ready(Ok(ClaudeSideQuestionCopy::of_live(&live))).boxed(),
            Err(no_live_session) => match resume {
                Some(resume) => compose_resting_side_question_copy(
                    Arc::clone(&self.sources),
                    Arc::clone(&self.starts),
                    resume,
                )
                .boxed(),
                None => return Err(no_live_session.into()),
            },
        })
    }
}

// `copy` locked down for another session's ask, carrying the person's own deny rules from the
// settings files its process would load, which it loads none of. Fails as the copy cannot be
// composed or a settings file cannot be read as a strict JSON object.
async fn lock_down(
    copy: ClaudeCopyComposition,
    sources: Arc<ClaudeSpawnSources>,
) -> Result<ClaudeSideQuestionCopy, Box<dyn Error + Send + Sync>> {
    let copy = copy.await?;
    let settings_sources = sources
        .read_settings_sources(&copy.legs.spawn_environment, &copy.legs.working_directory)
        .await;
    let person_deny_rules = read_claude_deny_list(&settings_sources.sources()).await?;
    Ok(ClaudeSideQuestionCopy {
        reach: ClaudeOneTurnReach::LockedDown { person_deny_rules },
        ..copy
    })
}

// The copy of a session at rest, from its resume material: the legs a resume starts with, in the
// home that holds its conversation, with no callback tools and on the full id of its model, which
// the build's catalog resolves since no process of the session declared it. Fails as the context,
// the legs or the catalog cannot be read.
async fn compose_resting_side_question_copy(
    sources: Arc<ClaudeSpawnSources>,
    starts: Arc<dyn ClaudeProcessStarts>,
    resume: ResumeSessionParams,
) -> Result<ClaudeSideQuestionCopy, Box<dyn Error + Send + Sync>> {
    let context = resolve_claude_spawn_context(
        &sources.ports.spawn_contexts,
        &sources.pool,
        resume.session_id,
        resume.provider_account_id.clone(),
        &resume.row_values,
    )
    .await?
    .in_conversation_home(read_claude_conversation_home(&resume.runtime_metadata).as_deref());
    let legs = build_claude_spawn_bound_legs(
        ClaudeSpawnLegsRequest {
            session_id: resume.session_id,
            model: resume.model.as_str().to_owned(),
            execution_posture: resume.execution_posture,
            subagent_policy: resume.subagent_policy,
            tool_servers: resume.tool_servers,
            output_schema: None,
            on_mcp_server_status: None,
            command_channel: None,
            context,
            continues_interrupted_turn: false,
            resume_prompt: None,
        },
        &ClaudeSpawnLegServices::of(&sources),
    )
    .await?;
    let catalog = starts
        .read_model_catalog(
            legs.spawn_environment.clone(),
            resume.provider_account_id.clone(),
        )
        .await?;
    let declaration = read_claude_initialize_declaration(catalog.initialize.as_deref());
    Ok(ClaudeSideQuestionCopy {
        legs: ClaudeSpawnBoundLegs {
            model: claude_full_model_id(&declaration, &legs.model),
            ..without_credential_prompts(legs)
        },
        provider_account_id: resume.provider_account_id,
        parent_provider_session_id: resume.resume_handle,
        reach: ClaudeOneTurnReach::PLAN,
    })
}
