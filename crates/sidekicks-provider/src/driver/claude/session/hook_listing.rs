//! The hooks a Claude Code process lists, read from its `get_hooks_listing` reply into the
//! inspector's listing by event: each hook in Claude Code's own words with the settings file it
//! came from, the settings files it skipped, and what managed settings do to the hooks. The reply
//! is untrusted, so each member is read leniently and a row naming no hook is skipped.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::{
    ProviderHookPolicy, ProviderHookSettingsError, SessionHookListResponse,
    SessionProviderEventHook,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::PositiveNumber;
use sidekicks_contracts::wire::text::{ComposedText, NulFreeText};

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::rules::{
    CLAUDE_SHARED_SETTINGS_FILE, list_claude_local_settings_files, settings_path,
};
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsFiles, ClaudeSettingsReadError, ClaudeSettingsSources, find_claude_setting,
    read_claude_managed_settings, read_claude_settings_files,
};
use crate::driver::claude::session::transport::control::ClaudeSettingsErrorRow;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

// The tiers a listed hook names as its `source`, each kept in one known settings file or set of
// them; a plugin's or a session's hook, or a tier not named here, has no file to name.
const USER_SETTINGS_SOURCE: &str = "userSettings";
const PROJECT_SETTINGS_SOURCE: &str = "projectSettings";
const LOCAL_SETTINGS_SOURCE: &str = "localSettings";
const POLICY_SETTINGS_SOURCE: &str = "policySettings";

// The members of a stored hook that hold what it runs: a command's, a prompt's or an agent's, and
// an HTTP hook's address.
const HOOK_COMMAND_MEMBERS: [&str; 3] = ["command", "prompt", "url"];
// The member of an HTTP hook holding its headers, whose values a listing blanks.
const HOOK_HEADERS_MEMBER: &str = "headers";

/// The hooks a process listed, and every settings file the daemon could not read while naming the
/// file each hook came from; a hook from such a tier names no file.
#[derive(Debug)]
pub(crate) struct ClaudeHookListing {
    /// The listing by event.
    pub(crate) response: SessionHookListResponse,
    /// What could not be read.
    pub(crate) unread: Vec<ClaudeSettingsReadError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookListingReply {
    #[serde(default, deserialize_with = "read_lenient")]
    hooks: Option<LenientList<HookRow>>,
    #[serde(default, deserialize_with = "read_lenient")]
    errors: Option<LenientList<ClaudeSettingsErrorRow>>,
    #[serde(default, deserialize_with = "read_lenient")]
    policy: Option<PolicyRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookRow {
    #[serde(default, deserialize_with = "read_lenient")]
    event: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    matcher: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    source: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    plugin_name: Option<String>,
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    hook_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    command_text: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    timeout: Option<f64>,
    #[serde(default, deserialize_with = "read_lenient")]
    status_message: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    disabled: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    editable: Option<EditableRow>,
}

// The entry as its settings file stores it: its raw matcher and the hook object itself, whose
// header values Claude Code blanks where it says so.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditableRow {
    #[serde(default, deserialize_with = "read_lenient")]
    matcher: Option<String>,
    #[serde(default)]
    config: Option<Value>,
    #[serde(default, deserialize_with = "read_lenient")]
    headers_redacted: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyRow {
    #[serde(default, deserialize_with = "read_lenient")]
    disabled_by_policy: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    managed_only: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    plugin_only: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    all_disabled: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    policy_hook_count: Option<u64>,
    #[serde(default, deserialize_with = "read_lenient")]
    policy_unreadable: Option<bool>,
}

lenient_object!(HookListingReply, HookRow, EditableRow, PolicyRow);

// One listed hook as the contract carries it, with its stored entry kept for naming its file.
struct ListedHook {
    hook: SessionProviderEventHook,
    editable: Option<EditableRow>,
}

/// The listing a `get_hooks_listing` `reply` carries for `session_id`, each hook naming the file
/// among `sources` it came from where exactly one can hold it. `None` when no listing can be read:
/// no reply, one that is not an object, hooks that are not a list, or no complete policy.
pub(crate) async fn read_claude_hook_listing(
    session_id: SessionId,
    reply: Option<&RawValue>,
    sources: &ClaudeSettingsSources<'_>,
) -> Option<ClaudeHookListing> {
    let reply = HookListingReply::read(&mut serde_json::Deserializer::from_str(reply?.get()))
        .ok()
        .flatten()?;
    let policy = read_policy(reply.policy.as_ref()?)?;
    let mut listed: Vec<ListedHook> = reply.hooks?.0.into_iter().filter_map(read_hook).collect();
    let errors = reply
        .errors
        .map(|errors| errors.0)
        .unwrap_or_default()
        .into_iter()
        .filter_map(read_settings_error)
        .collect();

    let mut unread = Vec::new();
    let lists_tier = |listed: &[ListedHook], source: &str| {
        listed
            .iter()
            .any(|listed| listed.hook.source.as_str() == source)
    };
    // A tier with a file that could not be read names no file, since that one may hold the hook.
    let mut take_whole_tier = |read: ClaudeSettingsFiles| {
        if read.failures.is_empty() {
            Some(read.files)
        } else {
            unread.extend(read.failures);
            None
        }
    };
    let local_files = if lists_tier(&listed, LOCAL_SETTINGS_SOURCE) {
        let files = list_claude_local_settings_files(
            &sources.project_folder,
            sources.home_folder,
            sources.path_rules,
        );
        take_whole_tier(read_claude_settings_files(files).await)
    } else {
        None
    };
    let managed_files = match sources.managed_settings_folder {
        Some(folder) if lists_tier(&listed, POLICY_SETTINGS_SOURCE) => {
            take_whole_tier(read_claude_managed_settings(folder).await)
        }
        Some(_) | None => None,
    };
    let shared_settings_file = settings_path(
        sources.project_folder.working_folder,
        CLAUDE_SHARED_SETTINGS_FILE,
    );
    for listed in &mut listed {
        let file = match listed.hook.source.as_str() {
            USER_SETTINGS_SOURCE => Some(sources.account_settings_file),
            PROJECT_SETTINGS_SOURCE => Some(shared_settings_file.as_path()),
            // The local pair is every file Claude Code reads for its tier, so the only one present
            // holds the hook. The policy tier also takes managed sources the daemon never reads,
            // which can leave a lone managed file's hooks unloaded, so it names only a holder.
            LOCAL_SETTINGS_SOURCE => local_files
                .as_deref()
                .and_then(|files| pick_source_file(files, listed, true)),
            POLICY_SETTINGS_SOURCE => managed_files
                .as_deref()
                .and_then(|files| pick_source_file(files, listed, false)),
            _ => None,
        };
        listed.hook.source_path =
            file.and_then(|file| FilesystemPath::new(file.to_string_lossy().into_owned()).ok());
    }

    Some(ClaudeHookListing {
        response: SessionHookListResponse::ByEvent {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            folders: None,
            hooks: listed.into_iter().map(|listed| listed.hook).collect(),
            errors,
            policy,
        },
        unread,
    })
}

fn read_hook(row: HookRow) -> Option<ListedHook> {
    let text = |member: Option<String>| member.and_then(ComposedText::new);
    let hook = SessionProviderEventHook {
        event: text(row.event)?,
        matcher: NulFreeText::new(row.matcher.unwrap_or_default()).ok()?,
        source: text(row.source)?,
        plugin_name: text(row.plugin_name),
        hook_type: text(row.hook_type)?,
        command_text: text(row.command_text)?,
        status_message: text(row.status_message),
        timeout_seconds: row.timeout.and_then(PositiveNumber::new),
        disabled: row.disabled == Some(true),
        source_path: None,
    };
    Some(ListedHook {
        hook,
        editable: row.editable,
    })
}

fn read_settings_error(row: ClaudeSettingsErrorRow) -> Option<ProviderHookSettingsError> {
    Some(ProviderHookSettingsError {
        file: row.file.and_then(|file| FilesystemPath::new(file).ok()),
        path: NulFreeText::new(row.path.unwrap_or_default()).ok()?,
        message: row.message.and_then(ComposedText::new)?,
    })
}

fn read_policy(row: &PolicyRow) -> Option<ProviderHookPolicy> {
    Some(ProviderHookPolicy {
        disabled_by_policy: row.disabled_by_policy?,
        managed_only: row.managed_only?,
        plugin_only: row.plugin_only?,
        all_disabled: row.all_disabled?,
        policy_hook_count: row.policy_hook_count.and_then(SafeInt::<0>::new)?,
        policy_unreadable: row.policy_unreadable == Some(true),
    })
}

// The one file of a tier's `files` the hook came from: the only one present where `files` are
// every file Claude Code reads for the tier, or else the only one that holds the hook; `None` where
// no single file can be named.
fn pick_source_file<'files>(
    files: &'files [(PathBuf, Map<String, Value>)],
    listed: &ListedHook,
    is_every_candidate: bool,
) -> Option<&'files Path> {
    if is_every_candidate && let [(only, _)] = files {
        return Some(only);
    }
    let mut holding = files
        .iter()
        .filter(|(_, settings)| holds_listed_hook(settings, listed));
    let (file, _) = holding.next()?;
    holding.next().is_none().then_some(file.as_path())
}

// Whether `settings` holds the listed hook under `hooks.<event>`: its stored entry where the row
// carries one, else an entry with the row's matcher holding a hook that runs the row's command
// text, which never matches text whose control characters Claude Code made visible.
fn holds_listed_hook(settings: &Map<String, Value>, listed: &ListedHook) -> bool {
    let event = listed.hook.event.as_str();
    let Some(editable) = &listed.editable else {
        let command_text = listed.hook.command_text.as_str();
        return holds_hook(settings, event, listed.hook.matcher.as_str(), |hook| {
            HOOK_COMMAND_MEMBERS
                .iter()
                .any(|member| hook.get(member).and_then(Value::as_str) == Some(command_text))
        });
    };
    let (Some(matcher), Some(config)) = (editable.matcher.as_deref(), editable.config.as_ref())
    else {
        return false;
    };
    let is_headers_redacted = editable.headers_redacted == Some(true);
    holds_hook(settings, event, matcher, |hook| {
        is_stored_hook(hook, config, is_headers_redacted)
    })
}

// Whether `settings` stores, under `hooks.<event>`, an entry whose matcher (`''` where it has none)
// is `matcher` and whose hooks hold one `is_hook` takes.
fn holds_hook(
    settings: &Map<String, Value>,
    event: &str,
    matcher: &str,
    is_hook: impl Fn(&Value) -> bool,
) -> bool {
    find_claude_setting(settings, &["hooks", event])
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("matcher").map_or(Some(""), Value::as_str) == Some(matcher)
                    && entry
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|hooks| hooks.iter().any(&is_hook))
            })
        })
}

// Whether `hook`, as a settings file stores it, is the listed `config`; where Claude Code blanked
// the listed header values, every member but `headers` is compared.
fn is_stored_hook(hook: &Value, config: &Value, is_headers_redacted: bool) -> bool {
    if !is_headers_redacted {
        return hook == config;
    }
    let without_headers = |hook: &Value| {
        hook.as_object().map(|members| {
            let mut members = members.clone();
            members.remove(HOOK_HEADERS_MEMBER);
            members
        })
    };
    let hook = without_headers(hook);
    hook.is_some() && hook == without_headers(config)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::inspector::{
        ProviderHookPolicy, ProviderHookSettingsError, SessionHookListResponse,
        SessionProviderEventHook,
    };
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::number::PositiveNumber;
    use sidekicks_contracts::wire::text::{ComposedText, NulFreeText};
    use sidekicks_platforms::PathRules;

    use super::{ClaudeHookListing, read_claude_hook_listing};
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::session::rules::{
        CLAUDE_USER_SETTINGS_FILE, ClaudeProjectFolder, ClaudeRepository, local_settings_path,
    };
    use crate::driver::claude::session::settings_file::ClaudeSettingsSources;

    // The folders a listing is read against, all in one scratch folder: the account's settings
    // file, a home folder, an owned repository root, the working folder `work` inside it, and a
    // managed folder, spelled by the running system's path rules.
    struct ScratchTree {
        scratch: tempfile::TempDir,
        account_settings_file: PathBuf,
        home_folder: PathBuf,
        repository_root: PathBuf,
        working_folder: PathBuf,
        managed_folder: PathBuf,
        path_rules: PathRules,
    }

    impl ScratchTree {
        fn new() -> Self {
            let scratch = tempfile::tempdir().expect("a scratch folder");
            let repository_root = scratch.path().join("repository");
            Self {
                account_settings_file: scratch
                    .path()
                    .join("account")
                    .join(CLAUDE_USER_SETTINGS_FILE),
                home_folder: scratch.path().join("home"),
                working_folder: repository_root.join("work"),
                repository_root,
                managed_folder: scratch.path().join("managed"),
                path_rules: PathRules::NATIVE,
                scratch,
            }
        }

        // The listing `reply` carries for `session_id`, read against this tree.
        async fn read(
            &self,
            session_id: SessionId,
            reply: &serde_json::Value,
        ) -> ClaudeHookListing {
            let common_git_folder = self.repository_root.join(".git");
            let project_folder = ClaudeProjectFolder {
                working_folder: &self.working_folder,
                repository: Some(ClaudeRepository {
                    root: &self.repository_root,
                    common_git_folder: &common_git_folder,
                    is_owned_by_user: true,
                }),
            };
            let sources = ClaudeSettingsSources {
                managed_settings_folder: Some(&self.managed_folder),
                project_folder,
                home_folder: &self.home_folder,
                account_settings_file: &self.account_settings_file,
                path_rules: self.path_rules,
            };
            let reply = RawValue::from_string(reply.to_string()).expect("the reply is JSON");
            read_claude_hook_listing(session_id, Some(&reply), &sources)
                .await
                .expect("the reply holds a listing")
        }
    }

    // Writes `contents` to `file`, making its folder.
    fn write_settings(file: &Path, contents: &serde_json::Value) {
        fs::create_dir_all(file.parent().expect("a settings file sits in a folder"))
            .expect("the settings folder is made");
        fs::write(file, contents.to_string()).expect("the settings file is written");
    }

    fn text(words: &str) -> ComposedText {
        ComposedText::new(words.to_owned()).expect("the words are not empty")
    }

    fn file_path(file: &Path) -> FilesystemPath {
        FilesystemPath::new(file.to_string_lossy().into_owned()).expect("a scratch path fits")
    }

    fn session_id() -> SessionId {
        SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
    }

    // A policy that keeps every hook running.
    fn running_policy() -> serde_json::Value {
        json!({"disabledByPolicy": false, "managedOnly": false, "pluginOnly": false,
               "allDisabled": false, "policyHookCount": 0})
    }

    // The file each listed hook names, in the listing's order.
    fn listed_source_paths(listing: &ClaudeHookListing) -> Vec<Option<FilesystemPath>> {
        let SessionHookListResponse::ByEvent { hooks, .. } = &listing.response else {
            panic!("a Claude Code listing is by event");
        };
        hooks.iter().map(|hook| hook.source_path.clone()).collect()
    }

    // Killed by a closed parse of `type`, by the `sourceLabel` or its `~` taken as the path, by a
    // timeout reader that drops a whole number, by a plugin hook named at a fixed
    // `hooks/hooks.json`, by a local hook always named at the resolved local file, by an HTTP hook
    // whose listed header values are compared with the stored ones, by a managed hook always named
    // at `managed-settings.json` while a drop-in sits beside it, by a hook with an empty command
    // listed, or by a policy or error member dropped.
    #[tokio::test]
    async fn a_listed_hook_keeps_its_words_and_names_the_file_it_came_from() {
        let tree = ScratchTree::new();
        let stored_hook = json!({"type": "command", "command": "./check.sh"});
        let stored_http_hook = json!({"type": "http", "url": "https://example.test/notify",
                                      "headers": {"Authorization": "Bearer stored"}});
        write_settings(&tree.account_settings_file, &json!({"hooks": {}}));
        write_settings(
            &local_settings_path(&tree.repository_root),
            &json!({"hooks": {"PreToolUse": [
                {"matcher": "Bash", "hooks": [{"type": "command", "command": "./other.sh"}]}
            ]}}),
        );
        let working_local_settings = local_settings_path(&tree.working_folder);
        write_settings(
            &working_local_settings,
            &json!({"hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [stored_hook]}],
                "Notification": [{"hooks": [stored_http_hook]}]
            }}),
        );
        write_settings(
            &tree.managed_folder.join("managed-settings.json"),
            &json!({"hooks": {}}),
        );
        write_settings(
            &tree
                .managed_folder
                .join("managed-settings.d")
                .join("a.json"),
            &json!({"hooks": {}}),
        );
        let reply = json!({
            "events": [],
            "eventCatalog": [],
            "hooks": [
                {"event": "Stop", "matcher": "", "source": "userSettings",
                 "sourceLabel": "User settings (~/.claude/settings.json)",
                 "type": "webhook_v9", "commandText": "https://example.test/stop",
                 "timeout": 1.5, "statusMessage": "Telling the hook",
                 "editable": {"matcher": "", "config": {"type": "webhook_v9"}}},
                {"event": "PostToolUse", "matcher": "Edit", "source": "pluginHook",
                 "sourceLabel": "Plugin", "pluginName": "formatter", "type": "command",
                 "commandText": "format.sh", "disabled": true},
                {"event": "PreToolUse", "matcher": "Bash", "source": "localSettings",
                 "sourceLabel": "Local settings", "type": "command",
                 "commandText": "./check.sh", "timeout": 30,
                 "editable": {"matcher": "Bash", "config": stored_hook}},
                {"event": "Notification", "matcher": "", "source": "localSettings",
                 "sourceLabel": "Local settings", "type": "http",
                 "commandText": "https://example.test/notify",
                 "editable": {"matcher": "", "headersRedacted": true,
                              "config": {"type": "http", "url": "https://example.test/notify",
                                         "headers": {"Authorization": ""}}}},
                {"event": "SessionStart", "matcher": "", "source": "policySettings",
                 "sourceLabel": "Managed settings", "type": "command",
                 "commandText": "audit.sh", "timeout": 0},
                {"event": "Stop", "matcher": "", "source": "projectSettings",
                 "sourceLabel": "Project settings", "type": "command", "commandText": ""}
            ],
            "errors": [{"file": "/broken/settings.json", "path": "hooks.Stop",
                        "message": "Expected an array"}],
            "policy": {"disabledByPolicy": false, "managedOnly": true, "pluginOnly": false,
                       "allDisabled": true, "policyHookCount": 2, "policyUnreadable": true}
        });
        let session_id = session_id();

        let listing = tree.read(session_id, &reply).await;

        let hook = |event: &str, matcher: &str, source: &str, hook_type: &str, command: &str| {
            SessionProviderEventHook {
                event: text(event),
                matcher: NulFreeText::new(matcher.to_owned()).expect("the matcher holds no NUL"),
                source: text(source),
                plugin_name: None,
                hook_type: text(hook_type),
                command_text: text(command),
                status_message: None,
                timeout_seconds: None,
                disabled: false,
                source_path: None,
            }
        };
        let expected = SessionHookListResponse::ByEvent {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            folders: None,
            hooks: vec![
                SessionProviderEventHook {
                    status_message: Some(text("Telling the hook")),
                    timeout_seconds: PositiveNumber::new(1.5),
                    source_path: Some(file_path(&tree.account_settings_file)),
                    ..hook(
                        "Stop",
                        "",
                        "userSettings",
                        "webhook_v9",
                        "https://example.test/stop",
                    )
                },
                SessionProviderEventHook {
                    plugin_name: Some(text("formatter")),
                    disabled: true,
                    ..hook("PostToolUse", "Edit", "pluginHook", "command", "format.sh")
                },
                SessionProviderEventHook {
                    timeout_seconds: PositiveNumber::new(30.0),
                    source_path: Some(file_path(&working_local_settings)),
                    ..hook(
                        "PreToolUse",
                        "Bash",
                        "localSettings",
                        "command",
                        "./check.sh",
                    )
                },
                SessionProviderEventHook {
                    source_path: Some(file_path(&working_local_settings)),
                    ..hook(
                        "Notification",
                        "",
                        "localSettings",
                        "http",
                        "https://example.test/notify",
                    )
                },
                hook("SessionStart", "", "policySettings", "command", "audit.sh"),
            ],
            errors: vec![ProviderHookSettingsError {
                file: Some(file_path(Path::new("/broken/settings.json"))),
                path: NulFreeText::new("hooks.Stop".to_owned()).expect("the path holds no NUL"),
                message: text("Expected an array"),
            }],
            policy: ProviderHookPolicy {
                disabled_by_policy: false,
                managed_only: true,
                plugin_only: false,
                all_disabled: true,
                policy_hook_count: SafeInt::new(2).expect("two is a count"),
                policy_unreadable: true,
            },
        };
        assert_eq!(listing.response, expected);
        assert!(listing.unread.is_empty());
    }

    // Killed by a lone managed file named without holding the hook, as when another managed source
    // keeps that file's hooks from loading, by a managed hook never named, or by a number where the
    // stored entry belongs read as an empty entry, which no stored hook matches.
    #[rstest]
    #[case::holding("audit.sh", None, true)]
    #[case::not_holding("other.sh", None, false)]
    #[case::holding_with_a_number_for_its_entry("audit.sh", Some(json!(1.5)), true)]
    #[tokio::test]
    async fn a_managed_hook_names_only_a_file_that_holds_it(
        #[case] stored_command: &str,
        #[case] editable: Option<serde_json::Value>,
        #[case] is_named: bool,
    ) {
        let tree = ScratchTree::new();
        let managed_settings = tree.managed_folder.join("managed-settings.json");
        write_settings(
            &managed_settings,
            &json!({"hooks": {"SessionStart": [
                {"hooks": [{"type": "command", "command": stored_command}]}
            ]}}),
        );
        let mut row = json!({"event": "SessionStart", "matcher": "", "source": "policySettings",
                             "type": "command", "commandText": "audit.sh"});
        if let Some(editable) = editable {
            row["editable"] = editable;
        }
        let reply = json!({"hooks": [row], "policy": running_policy()});

        let listing = tree.read(session_id(), &reply).await;

        let named = is_named.then(|| file_path(&managed_settings));
        assert_eq!(listed_source_paths(&listing), vec![named]);
        assert!(listing.unread.is_empty());
    }

    // Killed by a local file that fails to read left out of `unread`, or by the tier's other file
    // named although the one that failed may hold the hook. The repository root's path holds a NUL
    // byte, so its local file fails to read before any system call, which is no absence; POSIX path
    // rules keep both local files candidates, the root's and the working folder's.
    #[tokio::test]
    async fn a_tier_with_a_file_that_fails_to_read_names_no_file() {
        let mut tree = ScratchTree::new();
        tree.repository_root = tree.scratch.path().join("repo\0root");
        tree.working_folder = tree.scratch.path().join("work");
        tree.path_rules = PathRules::Posix;
        let stored_hook = json!({"type": "command", "command": "./check.sh"});
        let root_local_settings = local_settings_path(&tree.repository_root);
        write_settings(
            &local_settings_path(&tree.working_folder),
            &json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [stored_hook]}]}}),
        );
        let reply = json!({
            "hooks": [{"event": "PreToolUse", "matcher": "Bash", "source": "localSettings",
                       "type": "command", "commandText": "./check.sh",
                       "editable": {"matcher": "Bash", "config": stored_hook}}],
            "policy": running_policy()
        });

        let listing = tree.read(session_id(), &reply).await;

        assert_eq!(listed_source_paths(&listing), vec![None]);
        let unread: Vec<&Path> = listing
            .unread
            .iter()
            .map(|unread| unread.path.as_path())
            .collect();
        assert_eq!(unread, vec![root_local_settings.as_path()]);
    }
}
