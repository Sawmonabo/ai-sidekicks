//! Cloning: `repo.clone` makes a project from a repository URL, and its card follows the clone
//! live: git's progress, the question git asks and the person's answer, a failure with git's last
//! line, cancel, and pulling large files afterwards.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::internal::branded::branded_uuid_id;
use crate::project::ProjectId;
use crate::repo::folders::FolderPath;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::BoundedInt;
use crate::wire::text::{FreeFormText, pattern_text};
use crate::wire::{NullableSchema, nullable};

ts_constants! {
    /// The longest repository URL `repo.clone` takes.
    pub const REPO_CLONE_URL_MAX_LEN: usize = 2048;
    /// The longest line of git's own words the clone card carries.
    pub const REPO_CLONE_LINE_MAX_LEN: usize = 1024;
    /// The longest answer to one of git's questions.
    pub const REPO_CLONE_ANSWER_MAX_LEN: usize = 4096;
    /// The code `repo.clone` answers with when it refuses a clone before it starts.
    REPO_CLONE_REFUSED_CODE = crate::jsonrpc::refusal::RefusalCode::RepoCloneRefused;
}

/// A line of git's own words.
pub type CloneLine = FreeFormText<REPO_CLONE_LINE_MAX_LEN>;

/// `repo.clone`: the repository's URL, the folder the clone goes into when it is not the machine's
/// clone folder, and the project whose failed or canceled clone this runs again. The reply names
/// the project, made at once and marked `cloning`; the clone ends in the ordinary attach.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoCloneRequest {
    /// The repository's URL, handed to git as typed.
    pub url: FreeFormText<REPO_CLONE_URL_MAX_LEN>,
    /// The folder the clone goes into.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FolderPath")]
    pub parent_folder: Option<FolderPath>,
    /// The project whose clone runs again.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
}

/// The details of a `repo.clone_refused` refusal: `destination_not_empty` when the destination
/// holds something, `no_directory_name` when git can name no folder from the address, with git's
/// own line, which the clone card shows as it shows any clone's failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "reason",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepoCloneRefusedDetails {
    /// The destination holds something.
    DestinationNotEmpty {},
    /// Git can name no folder from the address.
    NoDirectoryName {
        /// Git's own line.
        line: CloneLine,
    },
}

/// The `repo.clone` result: the project the clone fills.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoCloneResponse {
    /// The project.
    pub project_id: ProjectId,
}

/// `repo.cloneSubscribe`, `repo.cloneCancel` and `repo.largeFilesPull`: the project a clone-card
/// request is about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoCloneProjectRequest {
    /// The project.
    pub project_id: ProjectId,
}

branded_uuid_id! {
    /// One question git is waiting on, minted when git's askpass program asks it.
    CloneQuestionId
}

/// Git's progress in its own words, `Receiving objects` at 42 percent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoCloneProgress {
    /// The phase, in git's words.
    pub phase: CloneLine,
    /// The whole percent git printed, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<BoundedInt<0, 100>>")]
    pub percent: Option<BoundedInt<0, 100>>,
}

/// A question git asked (a user name, a password or token, a key's passphrase, or whether to trust
/// a host's key), in git's own words. `masked` is true for a password or a passphrase.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoCloneQuestion {
    /// The question.
    pub question_id: CloneQuestionId,
    /// Git's words.
    pub prompt: CloneLine,
    /// Whether the answer is hidden as it is typed.
    pub masked: bool,
}

/// The step a failed clone failed at: `clone` or `large_files` with git's own line, or `sessions`
/// when the sessions that waited on the clone could not be started after it attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RepoCloneFailedStep {
    /// The clone.
    Clone,
    /// Pulling large files.
    LargeFiles,
    /// Starting the waiting sessions.
    Sessions,
}

/// One `repo.cloneSubscribe` emission, the clone card's whole state. `large_files_missing` means
/// the clone finished but the repository keeps large files in Git LFS, which is not installed, so
/// they arrived as placeholders; `canceled` and `done` end the card.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepoCloneStatus {
    /// Git is cloning.
    Cloning {
        /// The project.
        project_id: ProjectId,
        /// Git's latest progress, or `null`.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<RepoCloneProgress>")]
        progress: Option<RepoCloneProgress>,
        /// The question git is waiting on, or `null`.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<RepoCloneQuestion>")]
        question: Option<RepoCloneQuestion>,
    },
    /// Git is pulling large files.
    PullingLargeFiles {
        /// The project.
        project_id: ProjectId,
        /// Git's latest progress, or `null`.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<RepoCloneProgress>")]
        progress: Option<RepoCloneProgress>,
        /// The question git is waiting on, or `null`.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<RepoCloneQuestion>")]
        question: Option<RepoCloneQuestion>,
    },
    /// A step failed.
    Failed {
        /// The project.
        project_id: ProjectId,
        /// The step.
        step: RepoCloneFailedStep,
        /// Its last error line; `null` only when the service restarted during the clone and git
        /// left none.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<CloneLine>")]
        failure_line: Option<CloneLine>,
    },
    /// The clone finished with its large files left as placeholders.
    LargeFilesMissing {
        /// The project.
        project_id: ProjectId,
    },
    /// The clone was canceled.
    Canceled {
        /// The project.
        project_id: ProjectId,
    },
    /// The clone is done.
    Done {
        /// The project.
        project_id: ProjectId,
    },
}

pattern_text! {
    /// The answer to one of git's questions: one line with no NUL, possibly empty (an empty
    /// passphrase), since git's askpass program prints it as one line and a break would cut it
    /// short or smuggle a second.
    pub struct AskpassAnswer("^[^\\x00\\r\\n]*$", max = REPO_CLONE_ANSWER_MAX_LEN);
}

/// `repo.cloneAnswer`: the answer to one of git's questions. The daemon hands it to git's askpass
/// program and nowhere else; it is never stored, logged or echoed, and a transport that logs
/// request bodies must redact `answer`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoCloneAnswerRequest {
    /// The project.
    pub project_id: ProjectId,
    /// The question.
    pub question_id: CloneQuestionId,
    /// The answer.
    pub answer: AskpassAnswer,
}

/// `repo.cloneFolderRead` takes nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoCloneFolderReadRequest {}

/// Why a clone goes where it does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RepoCloneFolderSource {
    /// The folder the person set.
    Setting,
    /// The folder holding the most recently attached project.
    LastProject,
    /// The home folder.
    Home,
}

/// Where a clone goes, and why: the folder the person set, else the folder holding the most
/// recently attached project, else the home folder. The session picker and Settings › Projects
/// both read this one answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoCloneFolderReadResponse {
    /// The folder.
    pub folder: FolderPath,
    /// Why.
    pub source: RepoCloneFolderSource,
}

/// The TypeScript module of cloning.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "repo/clone",
    doc: "Cloning: repo.clone makes a project from a repository URL, and its card follows the \
          clone live.",
    definitions: &[
        Definition::read::<RepoCloneRequest>(),
        Definition::read::<RepoCloneRefusedDetails>(),
        Definition::read::<RepoCloneResponse>(),
        Definition::read::<RepoCloneProjectRequest>(),
        Definition::read::<CloneQuestionId>().checked(),
        Definition::read::<RepoCloneProgress>(),
        Definition::read::<RepoCloneQuestion>(),
        Definition::read::<RepoCloneFailedStep>(),
        Definition::read::<RepoCloneStatus>(),
        Definition::read::<AskpassAnswer>(),
        Definition::read::<RepoCloneAnswerRequest>().checked(),
        Definition::read::<RepoCloneFolderReadRequest>(),
        Definition::read::<RepoCloneFolderSource>(),
        Definition::read::<RepoCloneFolderReadResponse>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{AskpassAnswer, REPO_CLONE_ANSWER_MAX_LEN};

    #[rstest]
    #[case::empty(String::new(), true)]
    #[case::one_line("hunter2".to_owned(), true)]
    #[case::line_separator("pass\u{2028}word".to_owned(), true)]
    #[case::at_the_cap("a".repeat(REPO_CLONE_ANSWER_MAX_LEN), true)]
    #[case::line_feed("pass\nword".to_owned(), false)]
    #[case::carriage_return("pass\rword".to_owned(), false)]
    #[case::nul("pass\0word".to_owned(), false)]
    #[case::trailing_line_feed("line\n".to_owned(), false)]
    #[case::past_the_cap("a".repeat(REPO_CLONE_ANSWER_MAX_LEN + 1), false)]
    fn passes_one_line_to_askpass_and_refuses_a_break_or_nul(
        #[case] answer: String,
        #[case] is_passed: bool,
    ) {
        assert_eq!(AskpassAnswer::new(answer).is_some(), is_passed);
    }
}
