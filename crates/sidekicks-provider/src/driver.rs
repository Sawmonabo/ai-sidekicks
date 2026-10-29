//! The driver every provider implements, the table of providers, their registry and the shared turn
//! machinery. A provider's code stays in its own folder below; this file is the one other place
//! that names one, in its table entry.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::provider::id::{ProviderId, is_provider_id};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_platforms::{
    PathRules, PerSystem, Spawner, SystemFolders, can_create_user_namespace, find_executables,
};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;

use crate::background_work::BackgroundWorkForms;
use crate::command::waiting_checks::InputWaitReader;
use crate::command_search::ProviderCommandSearch;
use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::attachments::AttachmentResolver;
use crate::driver::contract::ProviderDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::ports::DriverPorts;
use crate::output_validation::is_canonical_semver;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::posture::ExecutionPostureService;
use crate::runtime_binding::writer::RuntimeBindingWriter;
use crate::spawn_environment::ReservedEnvironmentNames;

pub mod attachments;
pub mod callback_tool;
pub mod capabilities;
mod claude;
mod codex;
pub(crate) mod context_window;
pub mod contract;
pub mod daemon_stop;
pub(crate) mod delivery_dispatch;
pub mod diagnostics;
pub mod error_causes;
pub(crate) mod hook_pauses;
pub mod idle_sleep;
pub mod mcp_server_status;
pub mod message_handing;
pub mod ports;
pub(crate) mod question_answers;
pub mod registry;
pub(crate) mod reorder_buffer;
pub(crate) mod rewind;
pub mod run_control;
pub mod schema;
pub mod session_control;
pub(crate) mod streamed_text;
pub mod task_list;
#[cfg(any(test, feature = "test-support"))]
pub mod test_registry;
pub(crate) mod unified_diff;

/// The fixed facts a provider's driver declares about itself, the same for every installed build,
/// account, model and session; what depends on those comes from the driver's methods.
#[expect(
    dead_code,
    reason = "the provider list, the daemon's start, the capability report, the spawn \
              environment, the managed-settings checks, the memory gate and the sandboxed \
              permission level's check read each descriptor's facts"
)]
pub struct ProviderDescriptor {
    /// The provider's id: a lowercase letter, then up to 31 lowercase letters, digits or hyphens.
    pub id: &'static str,
    /// The provider's name as a person reads it.
    pub(crate) name: &'static str,
    /// Each plan id the provider sends and the word a person reads it as.
    pub(crate) plan_words: &'static [(&'static str, &'static str)],
    /// The provider's built-in tools in its own spelling, each with the words the picker draws.
    pub(crate) built_in_tools: &'static [(&'static str, &'static str)],
    /// How the provider's command is found on each kind of operating system.
    pub(crate) command: ProviderCommand,
    /// The folder on each operating system the provider reads the settings an administrator
    /// manages for everyone on the computer from; `None` where its documentation names none.
    pub(crate) managed_settings_folders: SystemFolders,
    /// Whether the provider runs its commands in a kernel sandbox on each operating system.
    pub(crate) command_sandbox: PerSystem<bool>,
    /// What the provider's command sandbox needs from the computer on each operating system.
    pub(crate) command_sandbox_needs: PerSystem<CommandSandboxNeeds>,
    /// What one start of the provider costs in memory before this machine has measured it.
    pub memory: ProviderMemoryEstimates,
    /// The provider's own word for standard output speed, as its declared state reads it; a run
    /// that carried another level and settles on another state is told fast output is unavailable.
    pub standard_output_speed: &'static str,
    /// The output-speed levels a person may request, for a provider that lists none per model;
    /// `None` where the provider lists them on each model of its catalog, so the two never both
    /// apply.
    pub(crate) output_speed_levels: Option<&'static [&'static str]>,
    /// The variables the app sets on every one of the provider's processes, each with its value,
    /// over anything the base or a person's row sets; the auto-update opt-out is among them.
    pub(crate) process_environment: &'static [(&'static str, &'static str)],
    /// The variables the daemon sets on the provider's launch alone, their values per launch.
    pub(crate) launch_environment_names: &'static [&'static str],
    /// The variables that point the provider at one account's own folders, which only the daemon
    /// sets.
    pub(crate) credential_home_environment_names: &'static [&'static str],
    /// The variables taken off the provider's processes even when the person's shell sets them; a
    /// command the person's project runs keeps them.
    pub(crate) withheld_environment_names: &'static [&'static str],
    /// The variables a Terminal pane's shell is given while `Simplify for a screen reader` is on.
    pub(crate) screen_reader_environment_names: &'static [&'static str],
    /// The voice kinds the provider offers, each at most once.
    pub(crate) voice_kinds: &'static [VoiceKind],
    /// The transports its tool servers are reached over.
    pub(crate) mcp_transports: &'static [McpTransport],
    /// The tool-server declaration members it reads beyond the shared ones.
    pub(crate) mcp_config_members: &'static [McpDeclaredConfigMember],
    /// The most characters it takes in a skill's name, where it sets a limit of its own.
    pub(crate) skill_name_max_length: Option<u64>,
    /// The forms of the provider's own command whose work would outlive the call, which no agent
    /// in a session may run, and the switch that turns them off; `None` where it has none.
    pub background_work: Option<BackgroundWork>,
    /// Whether the driver sets up the daemon's tool server so the provider asks before each call of
    /// the app's own tools itself; where it does not, the daemon raises the call's card.
    pub callback_tools_asked: bool,
    /// The folders, as components under an account home, the provider writes for its own
    /// diagnosis and never reads back for a session; `Keep diagnostic logs for` deletes their files
    /// by age in each account home the app manages.
    pub account_home_diagnostic_folders: &'static [&'static [&'static str]],
    /// The folders, as components under an account home, the provider keeps its conversations
    /// and their files in, which hold no credential; a backup keeps them in each account home the
    /// app manages.
    pub(crate) account_home_conversation_folders: &'static [&'static [&'static str]],
    /// How the provider runs every shell command through the command wrapper's link, as one line
    /// handed over as the link's one argument; `None` where the provider starts its commands
    /// through the daemon's relay instead.
    pub(crate) shell_prefix_command: Option<ShellPrefixCommand>,
}

/// A provider's contract with the command wrapper's link when it prefixes every shell command it
/// runs with it: the variable it reads the link's path from, the variable it names the shell an
/// agent's line was written for in, and how a line it hands the link tells an agent's command from
/// its hooks', status line's and tool servers' starts.
pub(crate) struct ShellPrefixCommand {
    /// The variable the provider reads the link's absolute path from.
    pub(crate) variable: &'static str,
    /// The variable the provider sets, in an agent's command's environment, to the absolute path
    /// of the shell it wrote the command's line for, which runs the line.
    pub(crate) shell_variable: &'static str,
    /// The command an agent ran that `line` runs, as the line runs it; `None` for a line that is no
    /// agent's command, which the wrapper runs as it is at once.
    pub(crate) read_agent_command: fn(&str) -> Option<String>,
}

/// The shell prefix contract of the provider whose id is `provider_id`; `None` for an unknown id or
/// a provider that prefixes no command.
pub(crate) fn shell_prefix_command_of(provider_id: &str) -> Option<&'static ShellPrefixCommand> {
    PROVIDERS
        .iter()
        .find(|descriptor| descriptor.id == provider_id)
        .and_then(|descriptor| descriptor.shell_prefix_command.as_ref())
}

impl ProviderDescriptor {
    /// The variables a Terminal pane's shell is given while `Simplify for a screen reader` is on.
    pub fn screen_reader_environment_names(&self) -> &'static [&'static str] {
        self.screen_reader_environment_names
    }

    /// The provider's id as the wire carries it; the table's build check holds its pattern.
    pub(crate) fn provider_id(&self) -> ProviderId {
        ProviderId::new(self.id.to_owned()).expect("a table id matches the provider id pattern")
    }

    /// How the provider's command is found on a system that follows `rules`; `None` where the
    /// provider ships no build for that system.
    pub(crate) fn command_lookup(&self, rules: PathRules) -> Option<&ProviderCommandLookup> {
        match rules {
            PathRules::Posix => self.command.unix.as_ref(),
            PathRules::Windows => self.command.windows.as_ref(),
        }
    }

    /// The folder on the running system the provider reads its administrator-managed settings
    /// from, `None` where it names none there; the WSL server, a Linux build, answers Linux's.
    pub(crate) fn managed_settings_folder(&self) -> Option<PathBuf> {
        self.managed_settings_folders.native_path()
    }

    /// Whether the provider can run its commands in its kernel sandbox on the running system, as
    /// the computer's facts tell: it sandboxes there, every program the sandbox needs is found
    /// from `environment`, the provider's own, with `working_folder` and `skipped_folders` as the
    /// executable search takes them, and a user namespace is made where the sandbox needs one;
    /// where the provider's service also reports whether its sandbox is set up, the answer is
    /// [`CommandSandboxAvailability::AskTheService`]. It reads the file system and starts a short
    /// check process, so it runs on the daemon's spawner thread; the WSL server, a Linux build,
    /// answers Linux's. Fails with the system's error from the namespace check.
    pub(crate) fn can_run_command_sandbox(
        &self,
        environment: &[(String, String)],
        working_folder: &Path,
        skipped_folders: &[PathBuf],
    ) -> std::io::Result<CommandSandboxAvailability> {
        if !*self.command_sandbox.native() {
            return Ok(CommandSandboxAvailability::CannotRun(
                MissingSandboxPrerequisite::NoSandbox,
            ));
        }
        let needs = self.command_sandbox_needs.native();
        let missing_program = needs.programs.iter().copied().find(|program| {
            find_executables(program, environment, working_folder, skipped_folders)
                .next()
                .is_none()
        });
        if let Some(program) = missing_program {
            return Ok(CommandSandboxAvailability::CannotRun(
                MissingSandboxPrerequisite::Program(program),
            ));
        }
        if needs.user_namespace && !can_create_user_namespace()? {
            return Ok(CommandSandboxAvailability::CannotRun(
                MissingSandboxPrerequisite::UserNamespace,
            ));
        }
        Ok(if needs.service_readiness {
            CommandSandboxAvailability::AskTheService
        } else {
            CommandSandboxAvailability::Runs
        })
    }

    /// The output-speed levels a capability report carries: the driver's fixed set where
    /// `output_speed` resolved on, else `None`, since an empty list would claim a settable axis
    /// with no values.
    pub(crate) fn static_output_speed_levels(
        &self,
        output_speed: bool,
    ) -> Option<Vec<ProviderToken>> {
        let levels = self.output_speed_levels.filter(|_| output_speed)?;
        Some(
            levels
                .iter()
                .map(|level| {
                    ProviderToken::new((*level).to_owned())
                        .expect("a driver's fixed output-speed level is a short, non-blank word")
                })
                .collect(),
        )
    }

    /// Every variable the app sets on the provider's processes or its Terminal pane's shells, which
    /// a person's own environment row may not name: the process, launch, credential-home and
    /// screen-reader names. The withheld names are left out, since a person's command keeps them.
    pub(crate) fn app_set_environment_names(&self) -> impl Iterator<Item = &'static str> {
        self.process_environment
            .iter()
            .map(|(name, _)| *name)
            .chain(self.launch_environment_names.iter().copied())
            .chain(self.credential_home_environment_names.iter().copied())
            .chain(self.screen_reader_environment_names.iter().copied())
            .chain(self.background_work.iter().map(|work| work.off_switch.0))
    }

    /// Every name the provider's command starts by, on any system.
    pub(crate) fn command_names(&self) -> impl Iterator<Item = &'static str> {
        [&self.command.unix, &self.command.windows]
            .into_iter()
            .flatten()
            .flat_map(|lookup| lookup.names.iter().copied())
    }
}

/// The forms of a provider's own command that start work outside the session that runs them:
/// work no agent of the session holds, that `Stop` and `Interrupt` never reach and that its
/// receipt never shows.
pub struct BackgroundWork {
    /// The subcommands whose work outlives the call, whatever follows them.
    pub(crate) subcommands: &'static [&'static str],
    /// The options, alone or with `=<value>`, that send a prompt to the background.
    pub(crate) flags: &'static [&'static str],
    /// The reason an agent reads when one of these commands is refused.
    pub refusal: &'static str,
    /// The variable and value that turn the provider's background work off, set on every
    /// provider's process and on the commands its conversation runs, so a nested run inherits it.
    pub(crate) off_switch: (&'static str, &'static str),
}

/// How a provider's command is found on each kind of operating system: Windows, and macOS and
/// Linux together. `None` where the provider ships no build for that system.
pub(crate) struct ProviderCommand {
    /// On Windows.
    pub(crate) windows: Option<ProviderCommandLookup>,
    /// On macOS and Linux.
    pub(crate) unix: Option<ProviderCommandLookup>,
}

/// Where a provider's command is looked for on one kind of operating system once the search paths
/// hold none: the names it starts by and the folders its own installer puts it in.
pub(crate) struct ProviderCommandLookup {
    /// The command's names, tried in order.
    pub(crate) names: &'static [&'static str],
    /// The folders the provider's own installer puts its command in, searched in order.
    pub(crate) install_folders: &'static [InstallFolder],
}

/// A folder a provider's installer puts its command in: path components under a base folder the
/// platforms crate finds for the person, so no descriptor holds a separator.
pub(crate) struct InstallFolder {
    /// The folder the components are under.
    pub(crate) base: InstallFolderBase,
    /// The components below `base`, outermost first.
    pub(crate) components: &'static [&'static str],
}

/// The folder an install folder sits under, which the platforms crate finds for the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallFolderBase {
    /// The person's home folder.
    Home,
    /// The person's own programs folder, which Windows has and macOS and Linux do not.
    UserPrograms,
}

/// What a provider's command sandbox needs from the computer on one operating system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CommandSandboxNeeds {
    /// The programs it runs from the provider's search path.
    pub(crate) programs: &'static [&'static str],
    /// Whether it makes a user namespace, which a computer can refuse a person.
    pub(crate) user_namespace: bool,
    /// Whether the provider's own service reports whether its sandbox is set up, which the driver
    /// reads from the service before the sandbox is offered.
    pub(crate) service_readiness: bool,
}

impl CommandSandboxNeeds {
    /// A sandbox that needs nothing the computer can lack.
    pub(crate) const NOTHING: Self = Self {
        programs: &[],
        user_namespace: false,
        service_readiness: false,
    };
}

/// Whether a provider's command sandbox runs on the running system, as the computer's facts tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CommandSandboxAvailability {
    /// It runs.
    Runs,
    /// It cannot run, for want of what is named.
    CannotRun(MissingSandboxPrerequisite),
    /// The computer has all it needs, and only the provider's own service knows whether its
    /// sandbox is set up; the driver reads that from the service before the sandbox is offered.
    AskTheService,
}

/// What a provider's command sandbox lacks on the running system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MissingSandboxPrerequisite {
    /// The provider runs no command sandbox on this system.
    NoSandbox,
    /// A program the sandbox runs, found on none of the provider's search paths.
    Program(&'static str),
    /// A user namespace, which the computer refuses this person.
    UserNamespace,
}

/// What one start of a provider costs in memory before this machine has measured it, each figure
/// the top of the range measured, in bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderMemoryEstimates {
    /// A new process of the provider.
    pub process_bytes: u64,
    /// One more conversation on a process of the provider already running; `None` where each
    /// conversation is a process of its own.
    pub conversation_bytes: Option<u64>,
}

/// The longest version text a provider's reply is read as a version from, in characters.
const VERSION_TOKEN_MAX_LEN: usize = 256;

/// What a provider's version reply says: its canonical version, or the reply text that carried
/// none, which the version gate keeps as the printed version with no parse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReportedVersionReading {
    /// The version, a canonical semantic version.
    Version(String),
    /// The reply's text, empty where the reply held none.
    UnreadableReply(String),
}

impl ReportedVersionReading {
    /// `token` as the version where it is a canonical semantic version of at most
    /// [`VERSION_TOKEN_MAX_LEN`] characters, else `reply`, the text
    /// that carried it, as unreadable; every driver's version reader decides through this one rule.
    pub(crate) fn from_token(token: &str, reply: &str) -> Self {
        if token.chars().count() <= VERSION_TOKEN_MAX_LEN && is_canonical_semver(token) {
            Self::Version(token.to_owned())
        } else {
            Self::UnreadableReply(reply.to_owned())
        }
    }
}

/// The one table of providers: each provider's registration, in the order the providers are listed
/// and their drivers registered, which the daemon's start builds the registry from once, and the
/// test registry in test builds.
pub const PROVIDER_REGISTRATIONS: &[ProviderRegistration] = &[
    ProviderRegistration {
        descriptor: &claude::DESCRIPTOR,
        build: claude::build,
    },
    ProviderRegistration {
        descriptor: &codex::DESCRIPTOR,
        build: codex::build,
    },
];

/// Every provider's descriptor, in the table's order.
pub const PROVIDERS: &[&ProviderDescriptor] =
    &descriptors_of::<{ PROVIDER_REGISTRATIONS.len() }>(PROVIDER_REGISTRATIONS);

/// The statements the drivers keep prepared on a read connection of the daemon's pool, which the
/// pool's capacity counts.
pub const DRIVERS_STATEMENT_CAPACITY: usize =
    codex::calibration::store::CODEX_CALIBRATION_STATEMENT_CAPACITY;

const _: () = assert!(
    has_valid_ids(PROVIDERS),
    "a provider id breaks the id pattern"
);
const _: () = assert!(has_unique_ids(PROVIDERS), "two providers share an id");

/// The shared services every driver's build takes, one bundle, so adding a provider never edits the
/// daemon's start. Each field is a handle a driver reads, every one provider-neutral: a provider's
/// own folders and settings stay in its driver, and what the daemon builds after the drivers is a
/// port in `ports`.
pub struct DriverServices {
    /// The one thread every child process is spawned from.
    pub spawner: Spawner,
    /// The daemon's data folder.
    pub data_folder: PathBuf,
    /// The person's home folder.
    pub home_folder: PathBuf,
    /// The read pool every driver's database read goes through.
    pub pool: Arc<DatabaseReadPool>,
    /// Binds a message's attachments to their stored copies.
    pub attachments: Arc<dyn AttachmentResolver>,
    /// Opens temporary worktrees of a folder's staged changes.
    pub staged_changes: StagedChangesWorktrees,
    /// Resolves each posture's curated credential list.
    pub execution_postures: Arc<ExecutionPostureService>,
    /// The login shell's environment captured at the daemon's start, every provider process's base.
    pub base_environment: Arc<[(String, String)]>,
    /// The names every provider sets on its processes, which no environment row may set.
    pub reserved_names: Arc<ReservedEnvironmentNames>,
    /// The search a provider's command falls back to once its spawn environment's `PATH` holds
    /// none.
    pub command_search: Arc<ProviderCommandSearch>,
    /// The compactions waiting for their provider's evidence, keyed by each driver's binding.
    pub pending_compactions: PendingCompactionRegistry,
    /// Which provider process runs each session, which each driver writes at spawn and exit.
    pub processes: Arc<ProviderProcessRegistry>,
    /// The processes serving the provider services the daemon holds a connection to, which each
    /// driver's dial holds and the daemon's caller check reads.
    pub provider_services: Arc<ProviderServiceProcesses>,
    /// Points a session's binding at the conversation a driver moved it onto.
    pub runtime_bindings: Arc<dyn RuntimeBindingWriter>,
    /// The daemon-wide bound on the shell-line bytes an ask's checks parse at once.
    pub shell_lines: Arc<ShellLineReadingBound>,
    /// Every provider's background work, which no agent's shell line may start.
    pub background_work: Arc<BackgroundWorkForms>,
    /// Whether the daemon's program runs the hook mode a provider's hook command starts, so a
    /// driver composes and trusts a hook that runs this program only while it does.
    pub dispatches_hook_mode: bool,
    /// Reads where a command channel's party runs, for its admission under the provider's process.
    pub caller_processes: Arc<dyn CallerProcessReader>,
    /// Reads whether a running command waits for input.
    pub input_waits: Arc<dyn InputWaitReader>,
    /// The handles the daemon builds after the drivers, each registered by its start.
    pub ports: Arc<DriverPorts>,
}

/// Where and as whom one session's provider process runs, and the settings the daemon keeps for the
/// session, as the daemon resolves them at every spawn; a provider's own settings for the session
/// stay with its driver.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSpawnContext {
    /// The session's working folder, its worktree, absolute.
    pub working_directory: PathBuf,
    /// The repository's git folder, the common one for a linked worktree; `None` outside one.
    pub git_common_folder: Option<PathBuf>,
    /// The machine's `Every project` environment rows.
    pub every_project_rows: Vec<EnvironmentRow>,
    /// The session's project's own environment rows, which win over an `Every project` row.
    pub project_rows: Vec<EnvironmentRow>,
    /// The folders of the account the process runs on.
    pub account_folders: ProviderAccountFolders,
    /// The session's own bound on the steps one turn may take; `None` where the person set none.
    pub step_bound: Option<SafeInt<1>>,
    /// The session's own advisor: `None` where it has none of its own, `Some(None)` where it is
    /// off.
    pub advisor_model: Option<Option<String>>,
}

/// The folders of an account's home, which the app manages for every account, each absolute: the
/// configuration folder a session reads and the account's own credential store, kept apart from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderAccountFolders {
    /// The configuration folder.
    pub configuration_folder: PathBuf,
    /// The account's credential store.
    pub credential_store_folder: PathBuf,
}

/// Resolves where a session's provider process runs. The daemon registers it on
/// [`DriverPorts::spawn_contexts`].
pub trait SessionSpawnContextResolver: Send + Sync {
    /// The context `session_id` runs in on `provider_account_id`'s account. Fails when the
    /// session or its account's folders cannot be read.
    fn resolve_spawn_context(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn Error + Send + Sync>>>;

    /// The folder `session_id`'s runs work in, absolute: its prepared root, else the folder its
    /// workspace was bound to, else its repository's checkout, so it answers before the session's
    /// first run prepares a root. Fails when the session or its folders cannot be read.
    fn resolve_run_folder(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<PathBuf, Box<dyn Error + Send + Sync>>>;
}

/// Reads the accounts a provider runs on: an account's folders before any session runs on it, and
/// its credential generation. The daemon registers it on [`DriverPorts::provider_accounts`].
pub trait ProviderAccountReader: Send + Sync {
    /// The folders of `provider_account_id`'s account, read with no session, before one exists.
    /// Fails as [`AccountFoldersError`] says.
    fn resolve_account_folders(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>>;

    /// The account `provider_id`'s runs start on when no account is named: its current account,
    /// or why it has none. Fails when the accounts cannot be read.
    fn current_account(
        &self,
        provider_id: ProviderId,
    ) -> BoxFuture<'_, Result<CurrentProviderAccount, Box<dyn Error + Send + Sync>>>;

    /// The current credential generation of `provider_account_id`'s account, from the accounts
    /// store, which a reading of the account carries so one from before a sign-in again reads as
    /// stale. Fails when the account cannot be read.
    fn read_credential_generation(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn Error + Send + Sync>>>;
}

/// Why an account's folders could not be resolved: the account is not registered, its home is not
/// there to run in, or the accounts could not be read.
#[derive(Debug, thiserror::Error)]
pub enum AccountFoldersError {
    /// No account of that id is registered.
    #[error("the account is not registered")]
    NotFound,
    /// The account's credential home is missing or cannot be used.
    #[error("the account's credential home is unavailable")]
    CredentialHomeUnavailable,
    /// The accounts could not be read.
    #[error("the account's folders could not be read")]
    Read(#[source] Box<dyn Error + Send + Sync>),
}

impl From<AccountFoldersError> for DriverError {
    /// An account that is not registered refuses `provider.account.notFound`, a home that cannot
    /// be used `provider.account.credentialHome.unavailable`, and a failed read is the driver's
    /// own failure.
    fn from(error: AccountFoldersError) -> Self {
        match error {
            AccountFoldersError::NotFound => Self::from(DomainError::new(
                "The provider account is not registered",
                RefusalCode::ProviderAccountNotFound,
            )),
            AccountFoldersError::CredentialHomeUnavailable => Self::from(DomainError::new(
                "The provider account's credential home is unavailable",
                RefusalCode::ProviderAccountCredentialHomeUnavailable,
            )),
            AccountFoldersError::Read(cause) => Self::Internal(cause),
        }
    }
}

/// The account a provider's runs start on when none is named, or why there is none: no account of
/// the provider is registered, or none of its registered accounts is current.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CurrentProviderAccount {
    /// The provider's current account.
    Current(ProviderAccountId),
    /// No account of the provider is registered.
    NoneRegistered,
    /// Accounts of the provider are registered and none is current.
    NoneCurrent,
}

impl CurrentProviderAccount {
    /// The current account. Refuses `provider.account.notRegistered` with no account of the
    /// provider registered and `provider.account.current.notSet` with none current.
    pub fn into_required(self) -> Result<ProviderAccountId, DriverError> {
        match self {
            Self::Current(provider_account_id) => Ok(provider_account_id),
            Self::NoneRegistered => Err(DriverError::from(DomainError::new(
                "No account of the provider is registered",
                RefusalCode::ProviderAccountNotRegistered,
            ))),
            Self::NoneCurrent => Err(DriverError::from(DomainError::new(
                "No account of the provider is current",
                RefusalCode::ProviderAccountCurrentNotSet,
            ))),
        }
    }
}

/// The current account of `provider_id`, read through `provider_accounts`. Refused
/// `provider.account.notRegistered` or `provider.account.current.notSet` as the accounts answer;
/// fails as no reader is registered or the accounts cannot be read.
pub async fn read_current_account(
    provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>,
    provider_id: ProviderId,
) -> Result<ProviderAccountId, DriverError> {
    provider_accounts
        .require_port()
        .map_err(|error| DriverError::Internal(Box::new(error)))?
        .current_account(provider_id)
        .await
        .map_err(DriverError::Internal)?
        .into_required()
}

/// One registered provider: its descriptor and the function that builds its driver from the shared
/// services, storing its handles without I/O.
pub struct ProviderRegistration {
    /// The provider's fixed facts.
    pub descriptor: &'static ProviderDescriptor,
    /// Builds the driver.
    pub build: fn(&DriverServices) -> Arc<dyn ProviderDriver>,
}

/// Whether every id in `table` matches the provider id pattern.
const fn has_valid_ids(table: &[&ProviderDescriptor]) -> bool {
    let mut i = 0;
    while i < table.len() {
        if !is_provider_id(table[i].id) {
            return false;
        }
        i += 1;
    }
    true
}

/// The descriptors of the first `N` of `registrations`, in their order; `N` is at least one.
const fn descriptors_of<const N: usize>(
    registrations: &[ProviderRegistration],
) -> [&'static ProviderDescriptor; N] {
    let mut descriptors = [registrations[0].descriptor; N];
    let mut i = 1;
    while i < N {
        descriptors[i] = registrations[i].descriptor;
        i += 1;
    }
    descriptors
}

/// Whether no two entries of `table` share an id.
const fn has_unique_ids(table: &[&ProviderDescriptor]) -> bool {
    let mut i = 0;
    while i < table.len() {
        let mut j = i + 1;
        while j < table.len() {
            if is_same_text(table[i].id, table[j].id) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}

/// Whether two texts hold the same bytes, in a form a constant can call.
pub(crate) const fn is_same_text(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut i = 0;
    while i < left.len() {
        if left[i] != right[i] {
            return false;
        }
        i += 1;
    }
    true
}
