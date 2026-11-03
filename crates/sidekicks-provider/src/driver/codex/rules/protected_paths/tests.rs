use std::path::Path;

use sidekicks_contracts::provider::settings::rules::ProviderProtectedPath;

use super::read_codex_protected_paths;
use crate::driver::codex::rules::CodexRulesError;
use crate::driver::codex::rules::listing::test_machine::{
    Machine, TRUSTED_MOUNT, file_path, mount, pattern,
};

// The strict profile home a and home b define, extending the system's base profile in home a.
const STRICT_PROFILE: &str = "[permissions.strict.filesystem]\n\"~/.ssh\" = \"deny\"\n\":minimal\" \
                              = \"read\"\n\n[permissions.strict.filesystem.\":workspace_roots\"]\n\
                              \".\" = \"write\"\n\"**/*.env\" = \"deny\"\n\n\
                              [permissions.loose.filesystem]\n\"~/.aws\" = \"deny\"\n";

// The protected paths are the deny entries of the profile each home's merged layers select,
// followed through the profiles it extends, each named by the layer file that set it: home a's
// strict profile brings in the system's base profile's entry; home b leaves the older sandbox key
// in force, so lists none of its own, until the trusted project selects the strict profile home b
// defines, whose entries then hold in that project; the untrusted project and the selected profile
// a home does not select give none. Killed by reading each file's profile alone, by dropping the
// profiles a profile extends, or by naming an entry by the file that selects the profile.
#[tokio::test]
async fn reads_the_denies_of_the_profile_the_merged_layers_select_through_its_parents() {
    let machine = Machine::new();
    let system = machine.write(
        "system/config.toml",
        "[permissions.base.filesystem]\n\"~/.kube\" = \"deny\"\n",
    );
    let home_a = machine.write(
        "home-a/codex/config.toml",
        &format!(
            "default_permissions = \"strict\"\n[permissions.strict]\nextends = \"base\"\n\n\
             {STRICT_PROFILE}"
        ),
    );
    let home_b = machine.write(
        "home-b/codex/config.toml",
        &format!("sandbox_mode = \"read-only\"\n{STRICT_PROFILE}"),
    );
    let personal = machine.write(
        "personal/config.toml",
        "default_permissions = \"strict\"\n[permissions.strict.filesystem]\n\"~/.gnupg\" = \
         \"deny\"\n",
    );
    let project_config = "default_permissions = \"strict\"\n[permissions.strict.filesystem]\n\
                          \"secrets\" = \"deny\"\n";
    let trusted = machine.write("trusted/.codex/config.toml", project_config);
    machine.write("untrusted/.codex/config.toml", project_config);

    let entries = read_codex_protected_paths(&machine.sources())
        .await
        .expect("the protected paths read");

    let global = |text: &str, path: &Path| ProviderProtectedPath::Global {
        pattern: pattern(text),
        place: None,
        source_path: file_path(path),
    };
    let project = |text: &str, path: &Path| ProviderProtectedPath::Project {
        pattern: pattern(text),
        source_path: file_path(path),
        repo_mount_id: mount(TRUSTED_MOUNT),
    };
    let expected = [
        global("~/.kube", &system),
        global("~/.ssh", &home_a),
        global(":workspace_roots/**/*.env", &home_a),
        global("~/.gnupg", &personal),
        project("secrets", &trusted),
        project("~/.ssh", &home_b),
        project(":workspace_roots/**/*.env", &home_b),
    ];
    assert_eq!(entries.len(), expected.len(), "{entries:?}");
    for entry in &expected {
        assert!(
            entries.contains(entry),
            "{entry:?} is listed in {entries:?}"
        );
    }
}

// A selected profile that extends one no layer defines does not resolve, so Codex would not start
// and the read fails rather than listing nothing. Killed by reading an undefined parent as none.
#[tokio::test]
async fn a_profile_extending_an_undefined_one_fails_the_read() {
    let machine = Machine::new();
    machine.write(
        "home-a/codex/config.toml",
        "default_permissions = \"strict\"\n[permissions.strict]\nextends = \"missing\"\n",
    );

    let read = read_codex_protected_paths(&machine.sources()).await;

    assert!(
        matches!(read, Err(CodexRulesError::UnresolvedProfile { .. })),
        "{read:?}"
    );
}

// Profiles that no layer selects one of, with the older sandbox key unset, make Codex refuse its
// config, so the read fails; the same profiles under the older key list none. Killed by reading
// unselected profiles as no protected paths, or by refusing them under the older key.
#[tokio::test]
async fn profiles_no_layer_selects_fail_the_read_unless_the_older_key_is_set() {
    let unselected = Machine::new();
    unselected.write("home-a/codex/config.toml", STRICT_PROFILE);
    let older_key = Machine::new();
    older_key.write(
        "home-a/codex/config.toml",
        &format!("sandbox_mode = \"workspace-write\"\n{STRICT_PROFILE}"),
    );

    let refused = read_codex_protected_paths(&unselected.sources()).await;
    let listed = read_codex_protected_paths(&older_key.sources()).await;

    assert!(
        matches!(refused, Err(CodexRulesError::ProfileUnselected)),
        "{refused:?}"
    );
    assert_eq!(listed.expect("the older key's config reads"), []);
}
