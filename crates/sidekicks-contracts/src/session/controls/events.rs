//! A session's notices and flow rows: the rows its controls write, the notices about its provider
//! (its build, its restarts, its warnings, its ignored settings, a level an account lacks) and
//! about the WSL 2 distribution it runs in, the flag from a provider's own reviewer, and the live
//! frame of a provider's safety hold on a turn.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::command::ExitCode;
use crate::error::ERROR_MESSAGE_MAX_LEN;
use crate::free_form_string::FilesystemPath;
use crate::place::{DistroName, Place};
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::{PROVIDER_WIRE_HANDLE_MAX_LEN, PROVIDER_WIRE_TOKEN_MAX_LEN};
use crate::provider::id::ProviderId;
use crate::provider::settings::PROVIDER_VERSION_MAX_LEN;
use crate::run::id::RunId;
use crate::session::controls::methods::{
    PermissionLevel, SessionReviewTarget, SideQuestionId, SideQuestionText,
};
use crate::session::cost::{TokensPerRun, UsdMicros};
use crate::session::id::SessionId;
use crate::turn::ProviderTurnId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::text::{ComposedText, FreeFormText};
use crate::wire::{Never, literal};

/// The `session.sideQuestion.answered` payload: the person's question and the provider's answer,
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

/// The `agent.run.stepLimit.reached` payload: a turn reached the step bound and ended there, and
/// the run then ends as interrupted. `count` is the bound reached, drawn beside `Continue`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunStepLimitReachedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The bound reached.
    pub count: SafeInt<1>,
}

/// The `session.spendLimit.reached` payload: the session's spend passed its `Spend limit`, so
/// every running turn in it stopped. `spendLimitUsdMicros` is the limit, drawn beside `Raise
/// limit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSpendLimitReachedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The limit passed.
    pub spend_limit_usd_micros: UsdMicros,
}

/// The `agent.run.tokenLimit.reached` payload: the run passed its `Tokens per run` and ended, and
/// the next message starts a new run. `tokenLimit` is the limit, drawn beside `Raise limit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunTokenLimitReachedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The limit passed.
    pub token_limit: TokensPerRun,
}

/// A provider's safety hold on a turn (`active`) or its release, with the faster model the
/// provider names, as sent. Relayed live on the run's state stream and never kept, so a re-opened
/// session does not show it again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSafetyBufferingUpdatedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The provider's turn id.
    pub turn_id: ProviderTurnId,
    /// Whether the hold is on.
    pub active: bool,
    /// The faster model the provider names, where it names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>")]
    pub faster_model: Option<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>,
}

literal! {
    /// The `settingsIgnored` notice kind.
    pub enum SettingsIgnoredKind = "settingsIgnored";
}

/// A provider started without part of its own settings, by a report naming a file and a line in
/// it, both always; quoted from the provider's report, never composed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SettingsIgnoredAtLineNotice {
    /// The session.
    pub session_id: SessionId,
    /// Always `settingsIgnored`.
    pub kind: SettingsIgnoredKind,
    /// The provider whose settings were ignored.
    pub provider: ProviderId,
    /// The settings file.
    pub file: FilesystemPath,
    /// The line in it.
    pub line: SafeInt<1>,
    /// Never present: a report naming a line names no key.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub key: Option<Never>,
}

/// A provider started without part of its own settings, by a report naming a file and the key with
/// the bad value, each where known and never a line; quoted from the provider's report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SettingsIgnoredAtKeyNotice {
    /// The session.
    pub session_id: SessionId,
    /// Always `settingsIgnored`.
    pub kind: SettingsIgnoredKind,
    /// The provider whose settings were ignored.
    pub provider: ProviderId,
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
    /// Never present: a report naming a key names no line.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub line: Option<Never>,
}

/// Which kind of notice a provider warning came from: a warning or a deprecation notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderWarningSource {
    /// A warning.
    Warning,
    /// A deprecation notice.
    Deprecation,
}

/// Every `session.notice.posted` kind but `settingsIgnored`, each drawn as one plain sentence. A
/// crash loop names exactly one of the exit code and the signal its process ended on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
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
    /// The provider ended the turn at its cap on unmet goal checks; the goal stays active.
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
        text: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
        /// The provider's details, where it sent any.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
        details: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
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
        provider: ProviderId,
        /// The version it left.
        from_version: FreeFormText<PROVIDER_VERSION_MAX_LEN>,
        /// The version it runs.
        to_version: FreeFormText<PROVIDER_VERSION_MAX_LEN>,
    },
    /// The person's restart brought back a provider the crash loop stopped; it ends the crash
    /// loop's banner and draws no row, and the daemon's own restarts write none.
    ProviderRestarted {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderId,
    },
    /// The provider process ended on its own too many times in a short window and the daemon
    /// stopped restarting it, with the exit code or the signal it ended on, exactly one of them;
    /// drawn as a banner.
    #[schemars(extend("oneOf" = [{ "required": ["exitCode"] }, { "required": ["signal"] }]))]
    ProviderCrashLoop {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderId,
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
        #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
        signal: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
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
        #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
        reason: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
    },
    /// The session's provider is not installed where the session runs, so no provider process
    /// started; `place` names where, present on a Windows computer with a WSL 2 distribution.
    ProviderMissing {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderId,
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
    /// The session, which runs in a WSL 2 distribution, cannot run while WSL does not answer; the
    /// daemon tries WSL again after each wake and once an hour.
    WslNotAnswering {
        /// The session.
        session_id: SessionId,
    },
    /// The WSL 2 distribution the session runs in stopped and could not start again, with the
    /// error the last start gave, word for word, where it gave one.
    DistributionRestartFailed {
        /// The session.
        session_id: SessionId,
        /// The distribution.
        distro: DistroName,
        /// The error the last start gave; absent where it printed nothing before its deadline.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<ERROR_MESSAGE_MAX_LEN>")]
        error: Option<FreeFormText<ERROR_MESSAGE_MAX_LEN>>,
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

/// The `session.notice.posted` payload. Its kinds are a closed set, each drawn as one plain
/// sentence; `settingsIgnored` takes one shape per kind of report: a file and a line, or a file and
/// a key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum SessionNoticePostedPayload {
    /// A provider ignored part of its settings, by a report naming a file and a line.
    SettingsIgnoredAtLine(SettingsIgnoredAtLineNotice),
    /// A provider ignored part of its settings, by a report naming a file and a key.
    SettingsIgnoredAtKey(SettingsIgnoredAtKeyNotice),
    /// Every other notice.
    Notice(#[garde(dive)] SessionNotice),
}

/// Which of a provider's reviewer signals a flag carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModerationReviewSignal {
    /// A warning.
    ReviewWarning,
    /// A required review.
    ReviewRequired,
}

/// The `approval.reviewer.flagged` payload: a warning or a required review from the provider's own
/// reviewer, drawn as one row in the provider's words. `eventId` names the item the flag is about;
/// `text` is the words the row shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalReviewerFlaggedPayload {
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
    pub text: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/controls/events",
    doc: "A session's notices and flow rows: the rows its controls write, the notices about its \
          provider and about the WSL 2 distribution it runs in, the flag from a provider's own \
          reviewer, and the live frame of a provider's safety hold on a turn.",
    definitions: &[
        Definition::read::<SessionSideQuestionAnsweredPayload>().checked(),
        Definition::read::<AgentRunStepLimitReachedPayload>().checked(),
        Definition::read::<SessionSpendLimitReachedPayload>().checked(),
        Definition::read::<AgentRunTokenLimitReachedPayload>().checked(),
        Definition::read::<RunSafetyBufferingUpdatedPayload>().checked(),
        Definition::read::<ProviderWarningSource>(),
        Definition::read::<SessionNoticePostedPayload>().checked(),
        Definition::read::<ModerationReviewSignal>(),
        Definition::read::<ApprovalReviewerFlaggedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
