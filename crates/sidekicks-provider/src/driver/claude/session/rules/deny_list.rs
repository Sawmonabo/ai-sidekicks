//! The person's own deny and ask rules, read from every settings file Claude Code loads for a
//! process: the managed settings, the account home's own file and the project's shared and local
//! files. A process that loads none of those files carries them in its `--settings` as deny rules
//! instead, so a call the person's sessions would ask about is refused rather than allowed. A file
//! that is absent holds none; one that is not a strict JSON object of the shape Claude Code reads
//! is refused, and nothing past it is read.

use std::path::Path;

use super::listing::{read_strict_settings, read_string_list};
use super::{
    CLAUDE_SHARED_SETTINGS_FILE, ClaudeRulesError, list_claude_local_settings_files, settings_path,
};
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsSources, list_managed_settings_files, refuse_unread_settings,
};

/// Every entry of `permissions.deny` and `permissions.ask` in the settings files `sources` names,
/// in Claude Code's own precedence: the managed settings, the project's local files, its shared
/// file, then the account home's own, whose `/path` rules are anchored at its config folder as
/// Claude Code anchors them. Fails with the first file or managed drop-in folder that cannot be
/// read, or that is not a strict JSON object with `permissions.deny` and `permissions.ask` lists.
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
        // The carried rules load from an inline `--settings`, where a `/path` rule anchors at the
        // working folder; the account file's own anchor at its config folder.
        let anchor = (file == sources.account_settings_file)
            .then(|| file.parent())
            .flatten();
        for list in ["deny", "ask"] {
            deny_rules.extend(
                read_string_list(&settings, &["permissions"], list, &file)?
                    .into_iter()
                    .map(|rule| match anchor {
                        Some(config_folder) => anchor_rule_at(rule, config_folder),
                        None => rule.to_owned(),
                    }),
            );
        }
    }
    Ok(deny_rules)
}

// `rule` with a `/path` pattern, gitignore negation kept, rewritten to the absolute `//path` under
// `folder`; any other rule as written.
fn anchor_rule_at(rule: &str, folder: &Path) -> String {
    let Some((tool, pattern)) = rule.split_once('(') else {
        return rule.to_owned();
    };
    let (negation, path) = match pattern.strip_prefix('!') {
        Some(path) => ("!", path),
        None => ("", pattern),
    };
    if !path.starts_with('/') || path.starts_with("//") {
        return rule.to_owned();
    }
    format!("{tool}({negation}/{}{path}", folder.display())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use sidekicks_platforms::PathRules;

    use super::*;
    use crate::driver::claude::session::rules::ClaudeProjectFolder;

    // Killed by reading only `deny`, which lets the copy read a file the person's sessions ask
    // about, and by carrying the account file's `/path` rule as written, which guards the project's
    // folder instead of the config folder; the project's own `/path` rule stays as written.
    #[tokio::test]
    async fn the_ask_copy_deny_list_carries_the_ask_rules_and_anchors_the_accounts_paths() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let working_folder = scratch.path().join("work");
        let config_folder = scratch.path().join("account");
        let account_settings_file = config_folder.join("settings.json");
        fs::create_dir_all(working_folder.join(".claude")).expect("the project folder is made");
        fs::create_dir_all(&config_folder).expect("the config folder is made");
        fs::write(
            settings_path(&working_folder, CLAUDE_SHARED_SETTINGS_FILE),
            r#"{"permissions": {"deny": ["Edit(/src/**)"], "ask": ["Read(./.env)"]}}"#,
        )
        .expect("the shared file is written");
        fs::write(
            &account_settings_file,
            r#"{"permissions": {"deny": ["Read(/secrets/**)", "Bash(rm:*)"], "ask": ["Read(!/keys)"]}}"#,
        )
        .expect("the account file is written");

        let rules = read_claude_deny_list(&ClaudeSettingsSources {
            managed_settings_folder: None,
            project_folder: ClaudeProjectFolder {
                working_folder: &working_folder,
                repository: None,
            },
            home_folder: &scratch.path().join("home"),
            account_settings_file: &account_settings_file,
            path_rules: PathRules::NATIVE,
        })
        .await
        .expect("every settings file reads");

        let config = config_folder.display();
        assert_eq!(
            rules,
            [
                "Edit(/src/**)".to_owned(),
                "Read(./.env)".to_owned(),
                format!("Read(/{config}/secrets/**)"),
                "Bash(rm:*)".to_owned(),
                format!("Read(!/{config}/keys)"),
            ]
        );
    }
}
