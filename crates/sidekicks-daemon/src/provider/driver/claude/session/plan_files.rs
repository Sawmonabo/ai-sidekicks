//! The plan files Claude Code keeps for one conversation: `<slug>.md`, its `<slug>.workshop.md`,
//! and each helper's `<slug>-agent-<agent id>.md`, in the plans folder its `plansDirectory`
//! setting names, relative to the project and inside it, else `<config folder>/plans`.

use std::collections::BTreeMap;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use serde_json::Value;
use sidekicks_platforms::{PathRules, resolve_path, resolve_path_against};

use crate::claude::session::settings_file::{is_unreadable_path, read_claude_settings_file};

/// One conversation with a plan: the folder it started in, the local settings file Claude Code
/// keeps for that project (at the repository's root in the normal case), and the name its plan
/// files carry.
pub(crate) struct ClaudePlan<'a> {
    /// The folder the conversation started in.
    pub(crate) project_folder: &'a Path,
    /// The project's local settings file Claude Code reads.
    pub(crate) root_local_settings: PathBuf,
    /// The name of the conversation's plan files.
    pub(crate) plan_slug: String,
}

/// The plan files of each of `plans`, in the plans folder its settings name and the default one,
/// since the setting may have changed while the conversation lived, each folder listed once for
/// them all. A folder counts as inside the project lexically, as Claude Code reads it, so a link
/// inside it still reaches out. Fails with `InvalidData` on a folder that is not UTF-8, and with
/// any read failure but an unreadable path.
pub(crate) async fn find_claude_plan_files(
    config_folder: &Path,
    plans: &[ClaudePlan<'_>],
) -> io::Result<Vec<PathBuf>> {
    let default_folder = resolve_path(to_folder_text(&config_folder.join("plans"))?)?;
    let mut plans_by_folder: BTreeMap<String, Vec<PlanFileNames>> = BTreeMap::new();
    for plan in plans {
        let names = PlanFileNames::new(&plan.plan_slug);
        let configured_folder = read_configured_plans_folder(
            config_folder,
            plan.project_folder,
            &plan.root_local_settings,
        )
        .await?;
        for folder in std::iter::once(default_folder.clone()).chain(configured_folder) {
            let folder_plans = plans_by_folder.entry(folder).or_default();
            if !folder_plans.contains(&names) {
                folder_plans.push(names.clone());
            }
        }
    }

    let mut found = Vec::new();
    for (folder, folder_plans) in plans_by_folder {
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
            if folder_plans
                .iter()
                .any(|names| names.is_plan_file(file_name))
            {
                found.push(entry.path());
            }
        }
    }
    Ok(found)
}

// The names of one conversation's plan files: its plan, its workshop and each helper's.
#[derive(Clone, PartialEq, Eq)]
struct PlanFileNames {
    plan_file_name: String,
    workshop_file_name: String,
    helper_file_prefix: String,
}

impl PlanFileNames {
    fn new(plan_slug: &str) -> Self {
        Self {
            plan_file_name: format!("{plan_slug}.md"),
            workshop_file_name: format!("{plan_slug}.workshop.md"),
            helper_file_prefix: format!("{plan_slug}-agent-"),
        }
    }

    fn is_plan_file(&self, file_name: &str) -> bool {
        file_name == self.plan_file_name
            || file_name == self.workshop_file_name
            // The prefix leaves a stem, so the extension is exactly the `.md` the name ends in.
            || (file_name.starts_with(&self.helper_file_prefix)
                && Path::new(file_name)
                    .extension()
                    .is_some_and(|extension| extension == "md"))
    }
}

// The plans folder the settings name, resolved, read where Claude Code reads `plansDirectory`,
// lowest precedence first: the home's settings, the project's shared settings, the starting
// folder's local settings, then the root's, whose value wins where both set it. `None` where none
// names one inside the project, or it is empty or holds a backslash where that separates nothing,
// each of which makes Claude Code fall back to the default folder.
async fn read_configured_plans_folder(
    config_folder: &Path,
    project_folder: &Path,
    root_local_settings: &Path,
) -> io::Result<Option<String>> {
    let local_settings = project_folder.join(".claude").join("settings.local.json");
    let mut settings_files = vec![
        config_folder.join("settings.json"),
        project_folder.join(".claude").join("settings.json"),
    ];
    if root_local_settings != local_settings {
        settings_files.push(local_settings);
    }
    settings_files.push(root_local_settings.to_path_buf());
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

    use super::{ClaudePlan, find_claude_plan_files};

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

        let local_settings = project_folder.join(".claude").join("settings.local.json");
        let plan = ClaudePlan {
            project_folder: &project_folder,
            root_local_settings: local_settings,
            plan_slug: PLAN_SLUG.to_owned(),
        };
        let mut found = find_claude_plan_files(&config_folder, &[plan])
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
