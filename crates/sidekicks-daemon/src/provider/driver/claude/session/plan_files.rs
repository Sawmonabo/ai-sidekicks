//! The plan files Claude Code keeps for one conversation: `<slug>.md`, its `<slug>.workshop.md`,
//! and each helper's `<slug>-agent-<agent id>.md`, in the plans folder its `plansDirectory`
//! setting names, relative to the project and inside it, else `<config folder>/plans`.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use serde_json::Value;
use sidekicks_platforms::{PathRules, resolve_path, resolve_path_against};

use crate::provider::driver::claude::session::settings_file::{
    is_unreadable_path, read_claude_settings_file,
};

/// The plan files of the conversation named `plan_slug`, in the configured plans folder and the
/// default one, since the setting may have changed while the conversation lived; a folder counts as
/// inside the project lexically, as Claude Code reads it, so a link inside it still reaches out.
/// Fails with `InvalidData` on a folder that is not UTF-8, and with any read failure but an
/// unreadable path.
pub(crate) async fn find_claude_plan_files(
    config_folder: &Path,
    project_folder: &Path,
    plan_slug: &str,
) -> io::Result<Vec<PathBuf>> {
    let default_folder = resolve_path(to_folder_text(&config_folder.join("plans"))?)?;
    let configured_folder = read_configured_plans_folder(config_folder, project_folder).await?;
    let mut folders = vec![default_folder];
    if let Some(configured_folder) = configured_folder
        && !folders.contains(&configured_folder)
    {
        folders.push(configured_folder);
    }

    let plan_file_name = format!("{plan_slug}.md");
    let workshop_file_name = format!("{plan_slug}.workshop.md");
    let helper_file_prefix = format!("{plan_slug}-agent-");
    let mut found = Vec::new();
    for folder in folders {
        let mut entries = match tokio::fs::read_dir(folder).await {
            Ok(entries) => entries,
            Err(error) if is_unreadable_path(&error) => continue,
            Err(error) => return Err(error),
        };
        while let Some(entry) = entries.next_entry().await? {
            // Claude Code names its plan files in UTF-8, so a name that is not names none of them.
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if file_name == plan_file_name
                || file_name == workshop_file_name
                // The prefix leaves a stem, so the extension is exactly the `.md` the name ends in.
                || (file_name.starts_with(&helper_file_prefix)
                    && Path::new(file_name)
                        .extension()
                        .is_some_and(|extension| extension == "md"))
            {
                found.push(entry.path());
            }
        }
    }
    Ok(found)
}

// The folder the settings name, resolved, or `None` when none names one inside the project or it
// holds a backslash where that separates nothing, either of which makes Claude Code fall back to
// the default folder.
// Where Claude Code reads `plansDirectory`, lowest precedence first: the home's settings, the
// project's shared settings, then its local settings; an empty value names nothing.
async fn read_configured_plans_folder(
    config_folder: &Path,
    project_folder: &Path,
) -> io::Result<Option<String>> {
    let settings_files = [
        config_folder.join("settings.json"),
        project_folder.join(".claude").join("settings.json"),
        project_folder.join(".claude").join("settings.local.json"),
    ];
    let mut configured = None;
    for settings_file in settings_files {
        let settings = read_claude_settings_file(&settings_file).await?;
        if let Some(value) = settings
            .as_ref()
            .and_then(|settings| settings.get("plansDirectory"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            configured = Some(value.to_owned());
        }
    }
    let Some(configured) = configured else {
        return Ok(None);
    };
    let project_root = resolve_path(to_folder_text(project_folder)?)?;
    // Claude Code, a JavaScript program, reads a bare drive naming the project's own (`C:`) as the
    // project, where the shared join reads the drive's root.
    let folder = if PathRules::NATIVE.is_drive_of(&configured, &project_root) {
        project_root.clone()
    } else {
        resolve_path_against(&project_root, &configured)?
    };
    let is_inside_project = Path::new(&folder).starts_with(&project_root);
    let has_refused_backslash = !PathRules::NATIVE.is_separator('\\') && folder.contains('\\');
    Ok((is_inside_project && !has_refused_backslash).then_some(folder))
}

// The folder as text for the resolver, which folds paths as UTF-8 and never through a lossy step.
fn to_folder_text(folder: &Path) -> io::Result<&str> {
    folder
        .to_str()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidData, "a Claude Code folder is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_platforms::PathRules;

    use super::find_claude_plan_files;

    const PLAN_SLUG: &str = "brave-otter";

    fn write_plan_file(folder: &Path) {
        fs::create_dir_all(folder).unwrap();
        fs::write(folder.join(format!("{PLAN_SLUG}.md")), "plan").unwrap();
    }

    fn write_plans_directory(settings_file: &Path, plans_directory: Option<&str>) {
        if let Some(plans_directory) = plans_directory {
            let settings = json!({"plansDirectory": plans_directory});
            fs::write(settings_file, settings.to_string()).unwrap();
        }
    }

    // `{scratch}` in a setting stands for the temp tree's root, which is not the working folder,
    // so a relative setting is proven to resolve against the project.
    #[rstest]
    #[case::a_folder_above_the_project(None, Some("../elsewhere"), None)]
    #[case::an_absolute_folder_outside_the_project(None, Some("{scratch}/elsewhere"), None)]
    #[case::an_absolute_folder_inside_the_project(
        None,
        Some("{scratch}/project/inside"),
        Some("inside")
    )]
    #[case::a_folder_inside_the_project(None, Some("sub/plans"), Some("sub/plans"))]
    #[case::a_folder_whose_name_starts_with_two_dots(None, Some("..foo"), Some("..foo"))]
    #[case::a_folder_with_a_backslash(
        None,
        Some(r"sub\plans"),
        PathRules::NATIVE.is_separator('\\').then_some("sub/plans")
    )]
    #[case::an_empty_later_setting(Some("sub/plans"), Some(""), Some("sub/plans"))]
    // `{drive}` is the project's own drive where the system has drive letters, else `.`.
    #[case::the_project_drive(None, Some("{drive}"), Some(""))]
    #[tokio::test]
    async fn searches_the_default_folder_and_a_configured_one_only_inside_the_project(
        #[case] shared_setting: Option<&str>,
        #[case] local_setting: Option<&str>,
        #[case] expected_project_folder: Option<&str>,
    ) {
        let scratch = tempfile::tempdir().unwrap();
        let scratch_root = scratch.path().to_str().unwrap();
        let config_folder = scratch.path().join("config");
        let project_folder = scratch.path().join("project");
        fs::create_dir_all(project_folder.join(".claude")).unwrap();
        for folder in ["", "inside", "sub/plans", r"sub\plans", "..foo"] {
            write_plan_file(&project_folder.join(folder));
        }
        write_plan_file(&scratch.path().join("elsewhere"));
        let default_folder = config_folder.join("plans");
        write_plan_file(&default_folder);
        fs::write(default_folder.join(format!("{PLAN_SLUG}-agent-a1.md")), "").unwrap();
        fs::write(default_folder.join("other-otter.md"), "").unwrap();
        let drive = if PathRules::NATIVE.has_drive_letters() {
            &scratch_root[..2]
        } else {
            "."
        };
        let in_scratch = |setting: Option<&str>| {
            setting.map(|text| {
                text.replace("{scratch}", scratch_root)
                    .replace("{drive}", drive)
            })
        };
        write_plans_directory(
            &project_folder.join(".claude").join("settings.json"),
            in_scratch(shared_setting).as_deref(),
        );
        write_plans_directory(
            &project_folder.join(".claude").join("settings.local.json"),
            in_scratch(local_setting).as_deref(),
        );

        let mut found = find_claude_plan_files(&config_folder, &project_folder, PLAN_SLUG)
            .await
            .unwrap();

        let mut expected: Vec<PathBuf> = vec![
            default_folder.join(format!("{PLAN_SLUG}.md")),
            default_folder.join(format!("{PLAN_SLUG}-agent-a1.md")),
        ];
        expected.extend(
            expected_project_folder
                .map(|folder| project_folder.join(folder).join(format!("{PLAN_SLUG}.md"))),
        );
        found.sort();
        expected.sort();
        assert_eq!(found, expected);
    }
}
