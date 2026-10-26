//! A held request's answer in Claude Code's own words, and the rule an ask's answer made, kept
//! once the answer went: a question goes back as the question tool's `answers`, keyed by each
//! question's own text, through the route it came by; an ask's allow hands back the call's input,
//! corrected where the person corrected it, with a project allow's rule for Claude Code to write;
//! a refusal carries the decline's reason.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::join_all;
use serde_json::{Map, Value, json};
use sidekicks_contracts::approval::RememberedScopeKind;
use sidekicks_contracts::question::{QuestionAnswer, QuestionPrompt};
use sidekicks_platforms::PathRules;

use crate::provider::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::provider::driver::claude::session::permissions::{
    ClaudePermissionsError, ClaudeProjectRuleFolders, keep_claude_project_rule,
    keep_claude_session_rule, read_claude_session_rules,
};
use crate::provider::driver::claude::session::rules::{
    ClaudeProjectFolder, ClaudeRepository, ClaudeRulesError, compose_claude_project_allow_update,
};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::question_answers::{
    QUESTION_UNSHOWN_REASON, read_question_answer_texts,
};
use crate::provider::port::permission_ask::{
    ProviderAnswerRule, ProviderAskAction, ProviderPermissionAnswer,
};
use crate::provider::port::registration::{PortRegistration, PortRegistrationError};
use crate::provider::port::repository_reader::{RepositoryReader, RepositoryReading};
use crate::provider::port::session_rules::SessionRulePort;

// The input members a file tool names its file or folder by, in the order they are read.
const CLAUDE_PATH_MEMBERS: [&str; 3] = ["file_path", "notebook_path", "path"];

/// How a question reached the daemon, which decides the shape its answer goes back in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeQuestionRoute {
    /// A `can_use_tool` ask on the question tool.
    Ask,
    /// The question hook, which holds the question tool at Sandboxed.
    Hook,
}

/// A question the person is asked, with the tool input its answer hands back.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeHeldQuestion {
    /// How it arrived.
    pub(crate) route: ClaudeQuestionRoute,
    /// The question tool's input as Claude Code sent it.
    pub(crate) input: Map<String, Value>,
    /// The questions as the card asks them, a malformed one left out.
    pub(crate) questions: Vec<QuestionPrompt>,
}

/// A tool ask the approval pipeline answers, with the input an allow hands back.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeHeldAsk {
    /// The call's input as Claude Code sent it.
    pub(crate) input: Map<String, Value>,
    /// What the call would do.
    pub(crate) action: ProviderAskAction,
}

/// Why an ask's answer could not be composed; nothing was written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeAskAnswerError {
    /// A correction names an action Claude Code takes no corrected form of.
    #[error("a Claude Code ask of this kind takes no corrected command or path")]
    CorrectionUnfit,
    /// The project allow's rule could not be composed.
    #[error(transparent)]
    ProjectAllow(#[from] ClaudeRulesError),
}

/// The question tool's answer in the shape its route takes: an ask's `allow` with the input, or
/// the question hook's `allow` with it, each carrying `answers`, one per question in order.
pub(crate) fn compose_claude_question_answer(
    question: &ClaudeHeldQuestion,
    answers: &[QuestionAnswer],
) -> Value {
    let mut updated_input = question.input.clone();
    updated_input.insert(
        "answers".to_owned(),
        Value::Object(compose_question_answers(&question.questions, answers)),
    );
    match question.route {
        ClaudeQuestionRoute::Ask => json!({"behavior": "allow", "updatedInput": updated_input}),
        ClaudeQuestionRoute::Hook => compose_pre_tool_use_allow(Some(updated_input)),
    }
}

/// The refusal of a question the questions card could not show, in the shape its route takes: an
/// ask's deny, or the question hook's deny, each telling the agent it was not answered.
pub(crate) fn compose_claude_question_refusal(route: ClaudeQuestionRoute) -> Value {
    match route {
        ClaudeQuestionRoute::Ask => {
            json!({"behavior": "deny", "message": QUESTION_UNSHOWN_REASON})
        }
        ClaudeQuestionRoute::Hook => serde_json::to_value(ClaudeHookAnswer::Deny {
            reason: QUESTION_UNSHOWN_REASON.to_owned(),
        })
        .expect("a hook answer of strings always serializes"),
    }
}

/// The question hook's allow with no answer, which lets one of the daemon's own tools run at
/// Sandboxed, or with the question tool's input once answered.
pub(crate) fn compose_pre_tool_use_allow(updated_input: Option<Map<String, Value>>) -> Value {
    let mut output = Map::from_iter([
        ("hookEventName".to_owned(), Value::from("PreToolUse")),
        ("permissionDecision".to_owned(), Value::from("allow")),
    ]);
    if let Some(updated_input) = updated_input {
        output.insert("updatedInput".to_owned(), Value::Object(updated_input));
    }
    json!({"hookSpecificOutput": output})
}

/// The ask's answer in Claude Code's own words: an allow hands back the call's input, with the
/// command or path as the person corrected it, and a project allow its rule for Claude Code to
/// write into its own folder's local settings; a refusal carries the decline's reason. Fails when
/// a correction names an action of a kind Claude Code takes no corrected form of, or the project
/// allow's rule cannot be composed.
pub(crate) fn compose_claude_ask_answer(
    ask: &ClaudeHeldAsk,
    answer: &ProviderPermissionAnswer,
    path_rules: PathRules,
) -> Result<Value, ClaudeAskAnswerError> {
    let (correction, made_rule) = match answer {
        ProviderPermissionAnswer::Refuse { reason, .. } => {
            return Ok(
                json!({"behavior": "deny", "message": reason.as_deref().unwrap_or_default()}),
            );
        }
        ProviderPermissionAnswer::Allow {
            correction,
            made_rule,
            ..
        } => (correction, made_rule),
    };
    let updated_input = match correction {
        Some(correction) => with_edited_action(ask, &correction.edited_action)?,
        None => ask.input.clone(),
    };
    let mut allow = Map::from_iter([
        ("behavior".to_owned(), Value::from("allow")),
        ("updatedInput".to_owned(), Value::Object(updated_input)),
    ]);
    let project_allow = match made_rule {
        Some(made) if made.rule.kind == RememberedScopeKind::Project => {
            compose_claude_project_allow_update(&made.rule, path_rules)?
        }
        Some(_) | None => None,
    };
    if let Some(project_allow) = project_allow {
        allow.insert(
            "updatedPermissions".to_owned(),
            json!([serde_json::to_value(project_allow)
                .expect("a rule update of strings always serializes")]),
        );
    }
    Ok(Value::Object(allow))
}

// The question tool's `answers`, keyed by each question's own text, as Claude Code reads them; a
// key by header loses the answer. Several picks join with a comma; a skipped question has no key.
fn compose_question_answers(
    questions: &[QuestionPrompt],
    answers: &[QuestionAnswer],
) -> Map<String, Value> {
    questions
        .iter()
        .enumerate()
        .filter_map(|(index, question)| {
            let texts = read_question_answer_texts(answers.get(index));
            (!texts.is_empty()).then(|| {
                (
                    question.text.as_str().to_owned(),
                    Value::from(texts.join(", ")),
                )
            })
        })
        .collect()
}

// The input with the command or path the person corrected in place of the one the call named.
fn with_edited_action(
    ask: &ClaudeHeldAsk,
    edited_action: &str,
) -> Result<Map<String, Value>, ClaudeAskAnswerError> {
    let mut input = ask.input.clone();
    let member = match &ask.action {
        ProviderAskAction::Command { .. } => "command",
        ProviderAskAction::FileChange { .. } | ProviderAskAction::FileRead { .. } => {
            CLAUDE_PATH_MEMBERS
                .into_iter()
                .find(|member| input.get(*member).is_some_and(Value::is_string))
                .ok_or(ClaudeAskAnswerError::CorrectionUnfit)?
        }
        ProviderAskAction::CommandInput { .. }
        | ProviderAskAction::Network { .. }
        | ProviderAskAction::Tool { .. } => return Err(ClaudeAskAnswerError::CorrectionUnfit),
    };
    input.insert(member.to_owned(), Value::from(edited_action));
    Ok(input)
}

/// What a made rule is kept with: the session's rules in force, the working folders' repositories,
/// the home folder of the place the sessions run in and how it spells paths.
pub(crate) struct ClaudeAnswerRules {
    /// The approval pipeline's read of the rules in force.
    pub(crate) session_rules: Arc<PortRegistration<Arc<dyn SessionRulePort>>>,
    /// The daemon's reads of the working folders' repositories.
    pub(crate) repositories: Arc<PortRegistration<Arc<dyn RepositoryReader>>>,
    /// The home folder of the place the sessions run in.
    pub(crate) home_folder: PathBuf,
    /// How that place spells and compares paths.
    pub(crate) path_rules: PathRules,
}

/// Why a made rule could not be kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeAnswerRuleError {
    /// The session's rules in force could not be read.
    #[error("the session's standing rules could not be read")]
    SessionRulesUnreadable(#[source] Box<dyn Error + Send + Sync>),
    /// The rule could not be handed to Claude Code or written.
    #[error(transparent)]
    Permissions(#[from] ClaudePermissionsError),
    /// The daemon's repository reads are not registered, so no project rule's file is known.
    #[error(transparent)]
    RepositoriesUnregistered(#[from] PortRegistrationError),
}

impl ClaudeAnswerRules {
    /// Keeps the rule an answer made, once the answer went: a session rule by resending the live
    /// session's permissions with it, a project rule in each of the project's working folders.
    /// Fails as the rules in force cannot be read or the rule cannot be handed over or written.
    pub(crate) async fn keep(
        &self,
        live: &LiveClaudeSession,
        made: &ProviderAnswerRule,
    ) -> Result<(), ClaudeAnswerRuleError> {
        if made.rule.kind == RememberedScopeKind::Session {
            let standing = read_claude_session_rules(&self.session_rules, live.session_id)
                .await
                .map_err(ClaudeAnswerRuleError::SessionRulesUnreadable)?;
            keep_claude_session_rule(live, &made.rule, &standing, self.path_rules).await?;
            return Ok(());
        }
        let repositories = self.repositories.require_port()?;
        let own_path = &live.spawn_bound_legs.working_directory;
        let readings = join_all(
            made.project_folders
                .iter()
                .chain(std::iter::once(own_path))
                .map(|folder| read_claude_repository(&**repositories, folder)),
        )
        .await;
        let mut folders: Vec<ClaudeProjectFolder<'_>> = made
            .project_folders
            .iter()
            .chain(std::iter::once(own_path))
            .zip(&readings)
            .map(|(working_folder, reading)| {
                claude_project_folder(working_folder, reading.as_ref())
            })
            .collect();
        let own_folder = folders.pop().expect("the own folder was read last");
        keep_claude_project_rule(
            &made.rule,
            &ClaudeProjectRuleFolders {
                project_folders: &folders,
                own_folder: &own_folder,
                home_folder: &self.home_folder,
            },
            self.path_rules,
        )
        .await?;
        Ok(())
    }
}

/// `working_folder` with what Claude Code reads to place its project settings, from its
/// repository `reading` where it sits in one.
pub(crate) fn claude_project_folder<'a>(
    working_folder: &'a Path,
    reading: Option<&'a (RepositoryReading, bool)>,
) -> ClaudeProjectFolder<'a> {
    ClaudeProjectFolder {
        working_folder,
        repository: reading.map(|(reading, is_owned_by_user)| ClaudeRepository {
            root: &reading.root,
            common_git_folder: &reading.common_git_folder,
            is_owned_by_user: *is_owned_by_user,
        }),
    }
}

/// The repository of `working_folder`, with whether the person owns its root and the `.git` and
/// `.claude` entries Claude Code reads its project settings beside; `None` outside git.
pub(crate) async fn read_claude_repository(
    repositories: &dyn RepositoryReader,
    working_folder: &Path,
) -> Option<(RepositoryReading, bool)> {
    let reading = repositories.read_repository(working_folder).await?;
    let owned = join_all(
        [
            reading.root.clone(),
            reading.root.join(".git"),
            reading.root.join(".claude"),
        ]
        .map(|entry| async move { repositories.is_owned_by_user(&entry).await }),
    )
    .await;
    let is_owned_by_user = owned.into_iter().all(|is_owned| is_owned);
    Some((reading, is_owned_by_user))
}
