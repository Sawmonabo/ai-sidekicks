//! Where Claude Code keeps the person's own memory, and where the memory import copies it: each
//! project's memory under their own `projects/<folder>/memory/` into the same folder of the
//! account's home, since the daemon names a project's folder the same in every home, and each
//! agent's notes under their own `agent-memory/<name>/` into the daemon's one agent-memory folder,
//! which every account's agents share.

use std::fs;
use std::io;

use sidekicks_platforms::PathRules;
use sidekicks_store::data_folder::agent_memory_folder;

use crate::account::credential_home::CredentialHome;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::contract::account::MemoryImportStore;

// The folder of a Claude Code home that holds one folder per project.
const PROJECTS_FOLDER: &str = "projects";

// A project folder's memory, which Claude Code keeps beside the project's conversations.
const PROJECT_MEMORY_FOLDER: &str = "memory";

// The person's own folder of each agent's notes kept across projects.
const AGENT_MEMORY_FOLDER: &str = "agent-memory";

/// The person's own Claude Code memory stores, in the configuration folder their environment
/// names, and where each lands for the account whose home is `home`. Blocks on the file system.
/// Fails when the person's projects folder cannot be listed.
pub(super) fn claude_memory_import_stores(
    legs: &ClaudeAccountLegs,
    home: &CredentialHome,
) -> io::Result<Vec<MemoryImportStore>> {
    let Some(own_folder) = claude_config_folder(&legs.base_environment, PathRules::NATIVE) else {
        return Ok(Vec::new());
    };
    let mut stores = Vec::new();
    match fs::read_dir(own_folder.join(PROJECTS_FOLDER)) {
        Ok(projects) => {
            for project in projects {
                let project = project?;
                if project.file_type()?.is_dir() {
                    stores.push(MemoryImportStore {
                        source: project.path().join(PROJECT_MEMORY_FOLDER),
                        destinations: vec![
                            home.path()
                                .join(PROJECTS_FOLDER)
                                .join(project.file_name())
                                .join(PROJECT_MEMORY_FOLDER),
                        ],
                    });
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    stores.push(MemoryImportStore {
        source: own_folder.join(AGENT_MEMORY_FOLDER),
        destinations: vec![agent_memory_folder(&legs.data_folder)],
    });
    Ok(stores)
}

#[cfg(test)]
mod tests;
