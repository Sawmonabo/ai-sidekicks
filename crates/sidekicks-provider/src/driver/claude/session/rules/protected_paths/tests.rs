use serde_json::json;
use sidekicks_contracts::provider::settings::rules::ProviderProtectedPath;

use super::read_claude_protected_paths;
use crate::driver::claude::session::rules::listing::ClaudeRuleProject;
use crate::driver::claude::session::rules::listing::test_tree::{
    Tree, account_homes, pattern, project_id, sources, wire_path, write,
};

// Killed by the managed settings or the person's own home left unread, by `Edit(…)` deny rules,
// the sandbox's `denyRead` or its `denyWrite` left unread, and by a deny rule that names no path,
// or an allow, listed as a protected path.
#[tokio::test]
async fn protected_paths_are_every_file_s_read_and_edit_denies_and_sandbox_denies() {
    let tree = Tree::new();
    write(
        &tree.managed_settings(),
        &json!({ "permissions": { "deny": ["Read(/etc/secrets/**)"] } }),
    );
    write(
        &tree.home_settings("home-1"),
        &json!({
            "permissions": {
                "deny": ["Read(~/.aws/**)", "Edit(secrets/**)", "Bash(rm:*)"],
                "allow": ["Read(src/**)"]
            },
            "sandbox": { "filesystem": { "denyRead": ["~/.ssh"], "denyWrite": ["/usr"] } }
        }),
    );
    write(
        &tree.home_settings("person"),
        &json!({ "permissions": { "deny": ["Edit(~/.gitconfig)"] } }),
    );
    write(
        &tree.local_settings(),
        &json!({ "permissions": { "deny": ["Read(.env)"] } }),
    );
    let environment: Vec<(String, String)> = Vec::new();
    let (managed, first_home, second_home, person_home, folder) = (
        tree.path("managed"),
        tree.path("home-1"),
        tree.path("home-2"),
        tree.path("person"),
        tree.path("project"),
    );
    let homes = account_homes([&first_home, &second_home], &environment);
    let projects = [ClaudeRuleProject {
        repo_mount_id: project_id(),
        folder: &folder,
    }];
    let sources = sources(&managed, &homes, &person_home, &projects, &environment);

    let paths = read_claude_protected_paths(&sources)
        .await
        .expect("the settings files read");

    let global = |text: &str, file: &std::path::Path| ProviderProtectedPath::Global {
        pattern: pattern(text),
        place: None,
        source_path: wire_path(file),
    };
    let home_file = tree.home_settings("home-1");
    assert_eq!(
        paths,
        [
            global("/etc/secrets/**", &tree.managed_settings()),
            global("~/.aws/**", &home_file),
            global("secrets/**", &home_file),
            global("~/.ssh", &home_file),
            global("/usr", &home_file),
            global("~/.gitconfig", &tree.home_settings("person")),
            ProviderProtectedPath::Project {
                pattern: pattern(".env"),
                source_path: wire_path(&tree.local_settings()),
                repo_mount_id: project_id(),
            },
        ]
    );
}
