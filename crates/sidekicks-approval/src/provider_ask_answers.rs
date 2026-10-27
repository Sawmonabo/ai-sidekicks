//! The few provider asks the daemon answers itself, with no rule evaluation and no card: it refuses
//! a command that starts a provider's background work, and allows an agent's own read or change of
//! a `.md` note in the agent-memory folder, as a provider allows its own memory folder unasked.
//! Every other ask is left to the rest of the permission check. Neither answer depends on the
//! session's level: the refusal holds at every level, and the memory asks arrive only at the
//! levels that ask.

use std::io;
use std::path::Path;

use sidekicks_platforms::PathRules;
use sidekicks_provider::port::permission_ask::ProviderAskAction;
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::trust_envelope::is_contained_within;

/// The daemon's own answer to an ask; a refusal carries the reason the agent reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderAskAnswer {
    /// The ask is allowed with no card.
    Allow,
    /// The ask is refused with no card.
    Deny {
        /// What the agent reads.
        reason: &'static str,
    },
}

// The extension of a note in the agent-memory folder.
const AGENT_NOTE_EXTENSION: &str = "md";

/// The daemon's own answer to an ask for `action`, or `None` when it has none and the ask goes on
/// to the person. `command_refusal` is what `refuse_background_work` read from a command action's
/// line on the ask's reader. `agent_memory_folder` is the one all-projects agent-memory folder; a
/// file is in it when its path, every link resolved, lies beneath that folder's, so a configuration
/// home's link to the folder counts and a link out of it does not, and a change is allowed only
/// when every file it touches is such a note. Fails when a path cannot be resolved for a reason
/// other than its absence.
pub(crate) async fn answer_provider_ask(
    action: &ProviderAskAction,
    command_refusal: Option<&'static str>,
    agent_memory_folder: &Path,
) -> io::Result<Option<ProviderAskAnswer>> {
    let paths: &[String] = match action {
        ProviderAskAction::Command { .. } => {
            return Ok(command_refusal.map(|reason| ProviderAskAnswer::Deny { reason }));
        }
        ProviderAskAction::FileChange { paths } => paths,
        ProviderAskAction::FileRead { path } => std::slice::from_ref(path),
        ProviderAskAction::CommandInput { .. }
        | ProviderAskAction::Network { .. }
        | ProviderAskAction::Tool { .. } => &[],
    };
    if paths.is_empty() {
        return Ok(None);
    }
    let folder_key = canonical_folder_path(agent_memory_folder).await?;
    for path in paths {
        if !is_agent_note(Path::new(path), &folder_key).await? {
            return Ok(None);
        }
    }
    Ok(Some(ProviderAskAnswer::Allow))
}

// Only an absolute path with no `.` or `..` part is judged: a `..` after a link resolves against
// the link's target, which a path joined on the folder's side would not see.
async fn is_agent_note(path: &Path, folder_key: &Path) -> io::Result<bool> {
    let text = path.to_string_lossy();
    let has_dot_part = text
        .split(|character| PathRules::NATIVE.is_separator(character))
        .any(|part| part == "." || part == "..");
    if !PathRules::NATIVE.is_absolute(&text)
        || has_dot_part
        || path
            .extension()
            .is_none_or(|extension| extension != AGENT_NOTE_EXTENSION)
    {
        return Ok(false);
    }
    let file_key = canonical_folder_path(path).await?;
    Ok(is_contained_within(&file_key, folder_key))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use rstest::rstest;
    use sidekicks_platforms::make_folder_link;
    use sidekicks_provider::port::permission_ask::ProviderAskAction;

    use super::{ProviderAskAnswer, answer_provider_ask};

    fn change(paths: &[&Path]) -> ProviderAskAction {
        ProviderAskAction::FileChange {
            paths: paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        }
    }

    // Killed by allowing a note reached by `..`, a link leading out of the folder, a change that
    // also touches a file that is no note, or by refusing a note reached through a configuration
    // home's link to the folder.
    #[rstest]
    #[case::through_the_homes_link(
        &["config/agent-memory/notes.md"],
        Some(ProviderAskAnswer::Allow)
    )]
    #[case::in_the_folder(&["memory/notes.md"], Some(ProviderAskAnswer::Allow))]
    #[case::a_dot_dot_part(&["memory/../memory/notes.md"], None)]
    #[case::a_link_out_of_the_folder(&["memory/escape/notes.md"], None)]
    #[case::one_file_is_no_note(&["memory/notes.md", "memory/script.sh"], None)]
    #[case::a_note_outside(&["outside/notes.md"], None)]
    #[tokio::test]
    async fn only_a_change_to_agent_notes_is_allowed(
        #[case] relative_paths: &[&str],
        #[case] answer: Option<ProviderAskAnswer>,
    ) {
        let root = tempfile::tempdir().expect("a scratch folder");
        let root = root.path();
        fs::create_dir_all(root.join("memory")).expect("the memory folder");
        fs::create_dir_all(root.join("config")).expect("the config home");
        fs::create_dir_all(root.join("outside")).expect("a folder outside");
        make_folder_link(&root.join("memory"), &root.join("config/agent-memory"))
            .expect("the home's link is made");
        make_folder_link(&root.join("outside"), &root.join("memory/escape"))
            .expect("the link out is made");
        let paths: Vec<_> = relative_paths
            .iter()
            .map(|relative| root.join(relative))
            .collect();
        let paths: Vec<&Path> = paths.iter().map(AsRef::as_ref).collect();

        let answered = answer_provider_ask(&change(&paths), None, &root.join("memory"))
            .await
            .expect("every path resolves");

        assert_eq!(answered, answer);
    }
}
