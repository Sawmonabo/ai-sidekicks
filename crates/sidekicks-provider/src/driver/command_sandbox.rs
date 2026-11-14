//! A provider's kernel sandbox for the commands it runs: what it needs from the computer on each
//! operating system, and whether it runs on this one.

use std::path::{Path, PathBuf};

use sidekicks_platforms::{can_create_user_namespace, find_executables};

use crate::driver::ProviderDescriptor;

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

impl ProviderDescriptor {
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
}
