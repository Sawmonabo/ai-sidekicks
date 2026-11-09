//! The person's own deny rules, read from every settings file Claude Code loads for a process: the
//! managed settings, the account home's own file and the project's shared and local files. A
//! process that loads none of those files carries them in its `--settings` instead. A file that is
//! absent holds none; one that is not a strict JSON object of the shape Claude Code reads is
//! refused, and nothing past it is read.

use super::listing::{read_strict_settings, read_string_list};
use super::{
    CLAUDE_SHARED_SETTINGS_FILE, ClaudeRulesError, list_claude_local_settings_files, settings_path,
};
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsSources, list_managed_settings_files, refuse_unread_settings,
};

/// Every entry of `permissions.deny` in the settings files `sources` names, in Claude Code's own
/// precedence: the managed settings, the project's local files, its shared file, then the account
/// home's own. Fails with the first file or managed drop-in folder that cannot be read, or that is
/// not a strict JSON object with a `permissions.deny` list.
pub(crate) async fn read_claude_deny_list(
    sources: &ClaudeSettingsSources<'_>,
) -> Result<Vec<String>, ClaudeRulesError> {
    let mut files = Vec::new();
    if let Some(managed_settings_folder) = sources.managed_settings_folder {
        let mut failures = Vec::new();
        files.extend(list_managed_settings_files(managed_settings_folder, &mut failures).await);
        refuse_unread_settings(failures)?;
    }
    files.extend(list_claude_local_settings_files(
        &sources.project_folder,
        sources.home_folder,
        sources.path_rules,
    ));
    files.push(settings_path(
        sources.project_folder.working_folder,
        CLAUDE_SHARED_SETTINGS_FILE,
    ));
    files.push(sources.account_settings_file.to_path_buf());
    let mut deny_rules = Vec::new();
    for file in files {
        let Some(settings) = read_strict_settings(&file).await? else {
            continue;
        };
        deny_rules.extend(
            read_string_list(&settings, &["permissions"], "deny", &file)?
                .into_iter()
                .map(str::to_owned),
        );
    }
    Ok(deny_rules)
}
