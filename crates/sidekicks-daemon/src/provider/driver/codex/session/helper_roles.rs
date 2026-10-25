//! The helpers a session's Codex conversation may start, as Codex's own role files: one file per
//! helper in the daemon's folder for the session, each a config layer Codex reads when the lead
//! starts that helper, and the conversation pointed at each file by name. The folder is rewritten
//! at every start and resume, and removed with the session's other daemon state.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};

use crate::file::atomic_write::write_file_atomically;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::session_control::SubagentDefinition;

/// A role file is readable and writable by the person alone.
const ROLE_FILE_MODE: u32 = 0o600;

/// One helper as the conversation's config names it: its role and the file that defines it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexHelperRole {
    /// The helper's name, which the lead's helper tool takes as the role.
    pub(crate) name: String,
    /// When the lead should hand work to it.
    pub(crate) description: String,
    /// The role file's absolute path.
    pub(crate) config_file: PathBuf,
}

/// A definition member a Codex role file has no place for, so the file carries none of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexRoleFileWithheldField {
    /// The tools the helper may use.
    Tools,
    /// How many turns the helper may take.
    MaxTurns,
}

impl CodexRoleFileWithheldField {
    /// The member's name as a definition spells it.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Tools => "tools",
            Self::MaxTurns => "maxTurns",
        }
    }
}

/// The members of `definition` a Codex role file cannot carry, in a fixed order.
pub(crate) fn read_codex_role_file_withheld_fields(
    definition: &SubagentDefinition,
) -> Vec<CodexRoleFileWithheldField> {
    [
        definition
            .tools
            .is_some()
            .then_some(CodexRoleFileWithheldField::Tools),
        definition
            .max_turns
            .is_some()
            .then_some(CodexRoleFileWithheldField::MaxTurns),
    ]
    .into_iter()
    .flatten()
    .collect()
}

// One role file as Codex reads it: `name`, `description` and `developer_instructions` always,
// since Codex skips a role file without them, then the model and effort where set.
#[derive(Serialize)]
struct CodexRoleFile<'definition> {
    name: &'definition str,
    description: &'definition str,
    developer_instructions: &'definition str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'definition str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_reasoning_effort: Option<&'definition str>,
}

// One role file to write: its name in the session's folder and its TOML.
struct ComposedRoleFile {
    file_name: String,
    text: String,
}

/// Writes one role file per definition into the session's folder under `roles_folder`, private to
/// the person, and removes any file an earlier start left there; with no definitions the folder
/// goes. Each file is replaced in one rename, so a helper starting meanwhile reads a whole file. A
/// blank prompt or description fails as `CodexError::DriverConfig` before anything is written; a
/// file-system failure fails as an internal driver error.
pub(crate) async fn write_codex_helper_roles(
    roles_folder: &Path,
    session_id: SessionId,
    definitions: &[SubagentDefinition],
) -> Result<Vec<CodexHelperRole>, DriverError> {
    let files = definitions
        .iter()
        .enumerate()
        .map(
            |(index, definition)| -> Result<ComposedRoleFile, CodexError> {
                Ok(ComposedRoleFile {
                    file_name: compose_role_file_name(index, &definition.name),
                    text: compose_codex_role_file(definition)?,
                })
            },
        )
        .collect::<Result<Vec<_>, CodexError>>()?;
    if files.is_empty() {
        remove_codex_helper_roles(roles_folder, session_id).await?;
        return Ok(Vec::new());
    }
    let session_folder = roles_folder.join(session_id.to_string());
    let folder = session_folder.clone();
    run_blocking(move || sidekicks_platforms::create_private_folder(&folder)).await?;
    let mut file_names = Vec::with_capacity(files.len());
    for file in files {
        write_file_atomically(
            &session_folder.join(&file.file_name),
            file.text,
            ROLE_FILE_MODE,
        )
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
        file_names.push(file.file_name);
    }
    let kept: HashSet<String> = file_names.iter().cloned().collect();
    let folder = session_folder.clone();
    run_blocking(move || remove_stale_entries(&folder, &kept)).await?;
    Ok(definitions
        .iter()
        .zip(file_names)
        .map(|(definition, file_name)| CodexHelperRole {
            name: definition.name.clone(),
            description: definition.description.clone(),
            config_file: session_folder.join(file_name),
        })
        .collect())
}

/// Removes the session's role files and their folder; a session that had none succeeds. A
/// file-system failure fails as an internal driver error.
pub(crate) async fn remove_codex_helper_roles(
    roles_folder: &Path,
    session_id: SessionId,
) -> Result<(), DriverError> {
    let session_folder = roles_folder.join(session_id.to_string());
    run_blocking(move || sidekicks_platforms::remove_tree(&session_folder)).await
}

// The role file's TOML for one helper; a blank prompt or description, which Codex refuses, fails
// naming the member.
fn compose_codex_role_file(definition: &SubagentDefinition) -> Result<String, CodexError> {
    for (member, text) in [
        ("prompt", &definition.prompt),
        ("description", &definition.description),
    ] {
        if text.chars().all(is_ecmascript_whitespace) {
            return Err(CodexError::DriverConfig {
                field: format!("subagentPolicy.definitions.{member}"),
                detail: format!(
                    "the helper \"{}\" cannot run on Codex: its {member} is blank",
                    definition.name
                ),
                cause: None,
            });
        }
    }
    let role_file = CodexRoleFile {
        name: &definition.name,
        description: &definition.description,
        developer_instructions: &definition.prompt,
        model: definition.model.as_ref().map(FreeFormText::as_str),
        model_reasoning_effort: definition.effort.as_ref().map(FreeFormText::as_str),
    };
    Ok(toml::to_string(&role_file).expect("a role file's members are TOML strings"))
}

// The file's name: its place in the list keeps two names apart that differ only in characters a
// file name cannot hold, each of which becomes `-`.
fn compose_role_file_name(index: usize, helper_name: &str) -> String {
    let safe_name: String = helper_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("{}-{safe_name}.toml", index + 1)
}

// Removes each entry of `folder` not named in `kept`: role files an earlier start wrote and any
// temporary file a crashed write left.
fn remove_stale_entries(folder: &Path, kept: &HashSet<String>) -> io::Result<()> {
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let is_kept = entry
            .file_name()
            .to_str()
            .is_some_and(|file_name| kept.contains(file_name));
        if !is_kept {
            sidekicks_platforms::remove_tree(&entry.path())?;
        }
    }
    Ok(())
}

// Runs one blocking file-system step off the runtime's workers.
async fn run_blocking(
    step: impl FnOnce() -> io::Result<()> + Send + 'static,
) -> Result<(), DriverError> {
    tokio::task::spawn_blocking(step)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::session::id::SessionId;

    use super::write_codex_helper_roles;
    use crate::provider::driver::codex::session::errors::CodexError;
    use crate::provider::driver::contract::DriverError;
    use crate::provider::driver::session_control::SubagentDefinition;

    #[tokio::test]
    async fn a_blank_prompt_is_refused_before_any_file_is_written() {
        let roles_folder = tempfile::tempdir().expect("a temporary folder is made");
        let session_id = SessionId::new("0190f3a2-7b4c-7d1e-8f00-000000000001")
            .expect("the text is a session id");
        let helper = |name: &str, prompt: &str| SubagentDefinition {
            name: name.to_owned(),
            prompt: prompt.to_owned(),
            description: "Reviews the change.".to_owned(),
            model: None,
            tools: None,
            effort: None,
            max_turns: None,
        };

        let refused = write_codex_helper_roles(
            roles_folder.path(),
            session_id,
            &[helper("reviewer", "Review it."), helper("tester", " \n\t")],
        )
        .await;

        let Err(DriverError::Internal(cause)) = refused else {
            panic!("a blank prompt is refused");
        };
        assert!(matches!(
            cause.downcast_ref::<CodexError>(),
            Some(CodexError::DriverConfig { field, .. })
                if field == "subagentPolicy.definitions.prompt"
        ));
        assert!(
            !roles_folder
                .path()
                .join(session_id.to_string())
                .try_exists()
                .expect("the folder's presence reads")
        );
    }
}
