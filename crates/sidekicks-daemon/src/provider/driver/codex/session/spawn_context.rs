//! Where a Codex session's conversation runs, which the daemon resolves at every start and resume,
//! and the item-injection method through which a loaded conversation takes changed instructions.

use std::error::Error;
use std::path::PathBuf;

use futures::future::BoxFuture;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;

use crate::provider::spawn_environment::{ReservedEnvironmentNames, SessionEnvironment};

/// Codex's item-injection method: appends items to a loaded thread's model-visible history, one
/// way a conversation takes changed instructions from its next turn. Codex takes any JSON as an
/// item, so one it does not recognize is dropped while the request still succeeds.
#[expect(
    dead_code,
    reason = "the Codex leg that hands a loaded conversation changed instructions sends it"
)]
pub(crate) const CODEX_THREAD_INJECT_ITEMS_METHOD: &str = "thread/inject_items";

/// Where one session's conversation runs, resolved by the daemon at every start and resume.
#[expect(
    dead_code,
    reason = "the Codex session's start and resume compose the conversation's settings from it"
)]
pub(crate) struct CodexSessionSpawnContext {
    /// The session's working folder, its worktree, absolute.
    pub(crate) working_directory: PathBuf,
    /// The repository's git folder, the common one for a linked worktree; `None` outside one.
    pub(crate) git_common_folder: Option<PathBuf>,
    /// The machine's `Every project` environment rows.
    pub(crate) every_project_rows: Vec<EnvironmentRow>,
    /// The session's project's own environment rows, which win over an `Every project` row.
    pub(crate) project_rows: Vec<EnvironmentRow>,
    /// The instructions the conversation runs under, sent on every start, resume and fork.
    pub(crate) base_instructions: Option<String>,
}

#[expect(
    dead_code,
    reason = "the Codex session's start and resume compose the conversation's settings from it"
)]
impl CodexSessionSpawnContext {
    /// The environment every process of this session starts from: `base`, the login shell's
    /// environment, under the context's rows, with `reserved_names` withheld from every row and
    /// every name compared under `rules`.
    pub(crate) fn session_environment<'context>(
        &'context self,
        base: &'context [(String, String)],
        reserved_names: &'context ReservedEnvironmentNames,
        rules: PathRules,
    ) -> SessionEnvironment<'context> {
        SessionEnvironment {
            base,
            every_project_rows: &self.every_project_rows,
            project_rows: &self.project_rows,
            reserved_names,
            rules,
        }
    }
}

/// Resolves where a session's conversation runs, wired by the daemon.
#[expect(
    dead_code,
    reason = "the Codex session's start and resume resolve each conversation's context through it"
)]
pub(crate) trait CodexSpawnContextResolver: Send + Sync {
    /// The context `session_id` runs in on `provider_account_id`'s account, or on the person's
    /// own sign-in when `None`. Fails when the session or its folders cannot be read.
    fn resolve_spawn_context(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
    ) -> BoxFuture<'_, Result<CodexSessionSpawnContext, Box<dyn Error + Send + Sync>>>;
}
