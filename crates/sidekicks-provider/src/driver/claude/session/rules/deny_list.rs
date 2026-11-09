//! The person's own deny and ask rules, read from every settings file Claude Code loads for a
//! process: the managed settings, the account home's own file and the project's shared and local
//! files. A process that loads none of those files carries them in its `--settings` as deny rules
//! instead, so a call the person's sessions would ask about is refused rather than allowed. A file
//! that is absent holds none; one that is not a strict JSON object of the shape Claude Code reads
//! is refused, and nothing past it is read.

use std::path::Path;

use sidekicks_platforms::PathRules;

use super::listing::{read_strict_settings, read_string_list};
use super::protected_paths::PATH_RULE_TOOLS;
use super::{
    CLAUDE_SHARED_SETTINGS_FILE, ClaudeRulesError, compose_path_content,
    list_claude_local_settings_files, settings_path,
};
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsSources, list_managed_settings_files, refuse_unread_settings,
};

/// Every entry of `permissions.deny` and `permissions.ask` in the settings files `sources` names,
/// in Claude Code's own precedence: the managed settings, the project's local files, its shared
/// file, then the account home's own. Each `/path` rule is written as the absolute path it names
/// where its own file sits: under the account home's config folder for that file's, under the
/// working folder for every other file's. Fails with the first file or managed drop-in folder
/// that cannot be read, or that is not a strict JSON object with `permissions.deny` and
/// `permissions.ask` lists.
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
        // The carried rules load from a `--settings` file, where a `/path` rule anchors at that
        // file's own folder, so each is made absolute at the folder Claude Code anchors its own
        // file's at: the account file's config folder, and the working folder for the managed,
        // shared and local files.
        let anchor = match file.parent() {
            Some(config_folder) if file == sources.account_settings_file => config_folder,
            _ => sources.project_folder.working_folder,
        };
        for list in ["deny", "ask"] {
            deny_rules.extend(
                read_string_list(&settings, &["permissions"], list, &file)?
                    .into_iter()
                    .map(|rule| anchor_rule_at(rule, anchor, sources.path_rules)),
            );
        }
    }
    Ok(deny_rules)
}

// `rule`, where it is a path tool's with a `/path` pattern, gitignore negation kept, rewritten to
// the absolute `//path` under `folder`, the folder spelled as Claude Code matches a literal path;
// any other rule as written.
fn anchor_rule_at(rule: &str, folder: &Path, path_rules: PathRules) -> String {
    let Some((tool, pattern)) = rule.split_once('(') else {
        return rule.to_owned();
    };
    if !PATH_RULE_TOOLS.contains(&tool) {
        return rule.to_owned();
    }
    let (negation, path) = match pattern.strip_prefix('!') {
        Some(path) => ("!", path),
        None => ("", pattern),
    };
    if !path.starts_with('/') || path.starts_with("//") {
        return rule.to_owned();
    }
    let folder = compose_path_content(&folder.to_string_lossy(), path_rules);
    format!("{tool}({negation}{folder}{path}")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use sidekicks_platforms::PathRules;

    use super::*;
    use crate::driver::claude::session::rules::ClaudeProjectFolder;

    // Killed by reading only `deny`, which lets the copy read a file the person's sessions ask
    // about; by carrying any file's `/path` rule as written, which the copy's `--settings` file
    // anchors at the daemon's settings folder instead; by anchoring the account file's at the
    // working folder or another file's at the config folder; and by rewriting a rule of a tool
    // that names no path.
    #[tokio::test]
    async fn the_ask_copy_deny_list_carries_the_ask_rules_each_path_anchored_at_its_source() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let working_folder = scratch.path().join("work");
        let config_folder = scratch.path().join("account");
        let managed_folder = scratch.path().join("managed");
        let account_settings_file = config_folder.join("settings.json");
        fs::create_dir_all(working_folder.join(".claude")).expect("the project folder is made");
        fs::create_dir_all(&config_folder).expect("the config folder is made");
        fs::create_dir_all(&managed_folder).expect("the managed folder is made");
        fs::write(
            managed_folder.join("managed-settings.json"),
            r#"{"permissions": {"deny": ["Read(/vault/**)"], "ask": []}}"#,
        )
        .expect("the managed file is written");
        fs::write(
            working_folder.join(".claude").join("settings.local.json"),
            r#"{"permissions": {"deny": [], "ask": ["Edit(/notes/**)"]}}"#,
        )
        .expect("the local file is written");
        fs::write(
            settings_path(&working_folder, CLAUDE_SHARED_SETTINGS_FILE),
            r#"{"permissions": {"deny": ["Edit(/src/**)"], "ask": ["Read(./.env)"]}}"#,
        )
        .expect("the shared file is written");
        fs::write(
            &account_settings_file,
            r#"{"permissions": {"deny": ["Read(/secrets/**)", "Bash(/usr/bin/make:*)"],
                "ask": ["Read(!/keys)", "Read(//etc/hosts)"]}}"#,
        )
        .expect("the account file is written");

        let rules = read_claude_deny_list(&ClaudeSettingsSources {
            managed_settings_folder: Some(&managed_folder),
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

        let work = working_folder.display();
        let config = config_folder.display();
        assert_eq!(
            rules,
            [
                format!("Read(/{work}/vault/**)"),
                format!("Edit(/{work}/notes/**)"),
                format!("Edit(/{work}/src/**)"),
                "Read(./.env)".to_owned(),
                format!("Read(/{config}/secrets/**)"),
                "Bash(/usr/bin/make:*)".to_owned(),
                format!("Read(!/{config}/keys)"),
                "Read(//etc/hosts)".to_owned(),
            ]
        );
    }
}
