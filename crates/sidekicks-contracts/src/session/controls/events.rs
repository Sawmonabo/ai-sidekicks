//! A session's notices and flow rows: the rows its controls write, the notices about its provider
//! (its build, its restarts, its warnings, a level an account lacks) and about the WSL 2
//! distribution it runs in, Codex's reviewer flag, and the live frame of Codex's safety hold on a
//! turn.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::command::ExitCode;
use crate::error::ERROR_MESSAGE_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::place::{DistroName, Place};
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::{DRIVER_WIRE_HANDLE_MAX_LEN, DRIVER_WIRE_TOKEN_MAX_LEN};
use crate::provider::name::{ClaudeProviderWord, CodexProviderWord, ProviderName};
use crate::provider::settings::PROVIDER_VERSION_MAX_LEN;
use crate::run::id::RunId;
use crate::session::controls::methods::{
    PermissionLevel, SessionReviewTarget, SideQuestionId, SideQuestionText,
};
use crate::session::cost::{TokensPerRun, UsdMicros};
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::literal;
use crate::wire::text::{ComposedText, FreeFormText};

/// The `session.side_question_answered` payload: the person's question and the provider's answer,
/// each as written. The aside never enters the conversation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSideQuestionAnsweredPayload {
    /// The session.
    pub session_id: SessionId,
    /// The side question.
    pub side_question_id: SideQuestionId,
    /// The question, as written.
    pub question: SideQuestionText,
    /// The provider's answer, as written.
    pub answer: FreeFormText<{ usize::MAX }>,
}

/// The `run.step_limit_reached` payload: a turn reached the step bound and ended there, and the run
/// then ends as interrupted. `count` is the bound reached, drawn beside `Continue`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunStepLimitReachedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The bound reached.
    pub count: SafeInt<1>,
}

/// The `session.spend_limit_reached` payload: the session's spend passed its `Spend limit`, so
/// every running turn in it stopped. `spend_limit_usd_micros` is the limit, drawn beside `Raise
/// limit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSpendLimitReachedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The limit passed.
    pub spend_limit_usd_micros: UsdMicros,
}

/// The `run.token_limit_reached` payload: the run passed its `Tokens per run` and ended, and the
/// next message starts a new run. `token_limit` is the limit, drawn beside `Raise limit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTokenLimitReachedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The limit passed.
    pub token_limit: TokensPerRun,
}

/// Codex's safety hold on a turn (`active`) or its release, with the faster model Codex names, as
/// sent. Relayed live on the run's state stream and never kept, so a re-opened session does not
/// show it again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSafetyBufferingUpdatedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The provider's turn id.
    pub turn_id: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
    /// Whether the hold is on.
    pub active: bool,
    /// The faster model Codex names, where it names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>")]
    pub faster_model: Option<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>,
}

literal! {
    /// The `settings_ignored` notice kind.
    pub enum SettingsIgnoredKind = "settings_ignored";
}

/// Codex started without part of its settings: the file and the line it names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct CodexSettingsIgnoredNotice {
    /// The session.
    pub session_id: SessionId,
    /// Always `settings_ignored`.
    pub kind: SettingsIgnoredKind,
    /// Always `codex`.
    pub provider: CodexProviderWord,
    /// The settings file.
    pub file: FilesystemPath,
    /// The line in it.
    pub line: SafeInt<1>,
}

/// Claude Code started without part of its settings: the file `doctor` names, with the key for one
/// bad value, or the managed settings file that holds a key lower; absent where no file the daemon
/// can read sets it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ClaudeSettingsIgnoredNotice {
    /// The session.
    pub session_id: SessionId,
    /// Always `settings_ignored`.
    pub kind: SettingsIgnoredKind,
    /// Always `claude`.
    pub provider: ClaudeProviderWord,
    /// The settings file, where one is known.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub file: Option<FilesystemPath>,
    /// The key with the bad value, where one is known.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub key: Option<ComposedText>,
}

/// Which kind of notice a provider warning came from: a warning or a deprecation notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProviderWarningSource {
    /// A warning.
    Warning,
    /// A deprecation notice.
    Deprecation,
}

/// Every `session.notice` kind but `settings_ignored`, each drawn as one plain sentence. A crash
/// loop names exactly one of the exit code and the signal its process ended on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
#[garde(custom(|notice: &Self, (): &()| notice.names_one_crash_loop_ending()))]
pub enum SessionNotice {
    /// The conversation was reopened to take new definitions.
    ConversationReloaded {
        /// The session.
        session_id: SessionId,
    },
    /// A review started.
    ReviewStarted {
        /// The session.
        session_id: SessionId,
        /// What the review covers.
        target: SessionReviewTarget,
    },
    /// A review finished.
    ReviewFinished {
        /// The session.
        session_id: SessionId,
    },
    /// Claude Code ended the turn at its cap on unmet checks; the goal stays active.
    GoalNotMet {
        /// The session.
        session_id: SessionId,
        /// The agent whose goal it is.
        agent_id: AgentId,
    },
    /// A goal check ran past its limit; the goal stays active.
    GoalCheckUnfinished {
        /// The session.
        session_id: SessionId,
        /// The agent whose goal it is.
        agent_id: AgentId,
    },
    /// A warning or a deprecation notice from the provider, in its own words.
    ProviderWarning {
        /// The session.
        session_id: SessionId,
        /// Which kind of notice it came from.
        source: ProviderWarningSource,
        /// The provider's words.
        text: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
        /// The provider's details, where it sent any.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
        details: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    },
    /// An account switch moved the session onto an account that cannot run the level it left, so
    /// it runs at `ask`; `level` is the level it left.
    LevelUnavailable {
        /// The session.
        session_id: SessionId,
        /// The level it left.
        level: PermissionLevel,
    },
    /// The session moved to the provider's new build, both versions as the provider reports them;
    /// drawn as a faint line above the composer until the next message is sent, never a row.
    ProviderUpdated {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderName,
        /// The version it left.
        from_version: FreeFormText<PROVIDER_VERSION_MAX_LEN>,
        /// The version it runs.
        to_version: FreeFormText<PROVIDER_VERSION_MAX_LEN>,
    },
    /// A provider process that ended on its own runs again, restarted by the daemon or by the
    /// person's restart; drawn as one row.
    ProviderRestarted {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderName,
    },
    /// The provider process ended on its own too many times in a short window and the daemon
    /// stopped restarting it, with the exit code or the signal it ended on, exactly one of them;
    /// drawn as a banner.
    #[schemars(extend("oneOf" = [{ "required": ["exitCode"] }, { "required": ["signal"] }]))]
    ProviderCrashLoop {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderName,
        /// The exit code it ended with, where it ended with one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ExitCode")]
        exit_code: Option<ExitCode>,
        /// The signal it ended on, where it ended on one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>")]
        signal: Option<FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>>,
    },
    /// The provider says fast output is not on for the run that asked for it, with its own reason
    /// when it sent one.
    FastOutputUnavailable {
        /// The session.
        session_id: SessionId,
        /// The run that asked for fast output.
        run_id: RunId,
        /// The provider's reason, where it sent one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
        reason: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    },
    /// The session's provider is not installed where the session runs, so no provider process
    /// started; `place` names where, present on a Windows computer with a WSL 2 distribution.
    ProviderMissing {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderName,
        /// Where the session runs.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Place")]
        place: Option<Place>,
    },
    /// The WSL 2 distribution the session runs in is no longer on this computer, so the session
    /// cannot run.
    DistributionRemoved {
        /// The session.
        session_id: SessionId,
        /// The distribution.
        distro: DistroName,
    },
    /// WSL does not answer, so the session, which runs in a WSL 2 distribution, cannot run until
    /// Windows restarts.
    WslNotAnswering {
        /// The session.
        session_id: SessionId,
    },
    /// The WSL 2 distribution the session runs in stopped and could not start again, with the
    /// error the last start gave, word for word.
    DistributionRestartFailed {
        /// The session.
        session_id: SessionId,
        /// The distribution.
        distro: DistroName,
        /// The error the last start gave.
        error: FreeFormText<ERROR_MESSAGE_MAX_LEN>,
    },
}

impl SessionNotice {
    /// Holds a crash loop to exactly one of the exit code and the signal its process ended on;
    /// every other kind names neither.
    fn names_one_crash_loop_ending(&self) -> garde::Result {
        match self {
            Self::ProviderCrashLoop {
                exit_code, signal, ..
            } => {
                if exit_code.is_some() == signal.is_some() {
                    Err(garde::Error::new(
                        "a crash loop names exactly one of exitCode and signal",
                    ))
                } else {
                    Ok(())
                }
            }
            Self::ConversationReloaded { .. }
            | Self::ReviewStarted { .. }
            | Self::ReviewFinished { .. }
            | Self::GoalNotMet { .. }
            | Self::GoalCheckUnfinished { .. }
            | Self::ProviderWarning { .. }
            | Self::LevelUnavailable { .. }
            | Self::ProviderUpdated { .. }
            | Self::ProviderRestarted { .. }
            | Self::FastOutputUnavailable { .. }
            | Self::ProviderMissing { .. }
            | Self::DistributionRemoved { .. }
            | Self::WslNotAnswering { .. }
            | Self::DistributionRestartFailed { .. } => Ok(()),
        }
    }
}

/// The `session.notice` payload. Its kinds are a closed set, each drawn as one plain sentence;
/// `settings_ignored` takes one shape per provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum SessionNoticePayload {
    /// Codex started without part of its settings.
    CodexSettingsIgnored(CodexSettingsIgnoredNotice),
    /// Claude Code started without part of its settings.
    ClaudeSettingsIgnored(ClaudeSettingsIgnoredNotice),
    /// Every other notice.
    Notice(#[garde(dive)] SessionNotice),
}

/// Which of Codex's reviewer signals a flag carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModerationReviewSignal {
    /// A warning.
    ReviewWarning,
    /// A required review.
    ReviewRequired,
}

/// The `moderation.review_flagged` payload: a warning or a required review from Codex's own
/// reviewer, drawn as one row in Codex's words. `event_id` names the item the flag is about;
/// `text` is the words the row shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModerationReviewFlaggedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The agent.
    pub agent_id: AgentId,
    /// The item the flag is about.
    pub event_id: ComposedText,
    /// Which signal it carries.
    pub signal: ModerationReviewSignal,
    /// The words the row shows.
    pub text: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/controls/events",
    doc: "A session's notices and flow rows: the rows its controls write, the notices about its \
          provider and about the WSL 2 distribution it runs in, Codex's reviewer flag, and the \
          live frame of Codex's safety hold on a turn.",
    definitions: &[
        Definition::read::<SessionSideQuestionAnsweredPayload>().checked(),
        Definition::read::<RunStepLimitReachedPayload>().checked(),
        Definition::read::<SessionSpendLimitReachedPayload>().checked(),
        Definition::read::<RunTokenLimitReachedPayload>().checked(),
        Definition::read::<RunSafetyBufferingUpdatedPayload>().checked(),
        Definition::read::<ProviderWarningSource>(),
        Definition::read::<SessionNoticePayload>().checked(),
        Definition::read::<ModerationReviewSignal>(),
        Definition::read::<ModerationReviewFlaggedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
