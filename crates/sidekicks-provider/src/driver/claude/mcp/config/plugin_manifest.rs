//! A plugin's `plugin.json` as Claude Code checks it against its manifest schema before it loads
//! the plugin: the manifest is an object, its `name` names the plugin, and each member the schema
//! knows has the form it takes. A component member is checked by its outer form alone (a path, a
//! list of paths, or an object), not by the entries inside it. A member the schema does not know
//! passes, as the schema leaves it unread.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};
use url::Url;

/// A dependency written as text: a plugin name, optionally with `@marketplace` and a version range.
static DEPENDENCY_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][-A-Za-z0-9._]*(@[A-Za-z0-9][-A-Za-z0-9._]*)?(@\^[^@]*)?$")
        .expect("the dependency pattern compiles")
});

/// A dependency's plugin or marketplace name written as an object's member.
static DEPENDENCY_PART: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][-A-Za-z0-9._]*$").expect("the dependency part pattern compiles")
});

/// The suffixes an MCP bundle's path or address ends with.
const BUNDLE_SUFFIXES: [&str; 2] = [".mcpb", ".dxt"];

/// A member of the manifest and the check its value passes.
type MemberCheck = (&'static str, fn(&Value) -> bool);

/// A `userConfig` key, which becomes a variable name.
static USER_CONFIG_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").expect("the option key pattern compiles")
});

/// The plugin name `manifest`, the object a plugin's `plugin.json` holds, gives where Claude Code
/// would load the plugin; else the first member it refuses, by its name.
pub(crate) fn read_plugin_manifest_name(
    manifest: &Map<String, Value>,
) -> Result<&str, &'static str> {
    let checks: [MemberCheck; 27] = [
        ("name", is_plugin_name),
        ("$schema", Value::is_string),
        ("displayName", Value::is_string),
        ("version", Value::is_string),
        ("description", Value::is_string),
        ("author", is_author),
        ("homepage", is_url),
        ("repository", Value::is_string),
        ("license", Value::is_string),
        ("keywords", |value| is_list_of(value, Value::is_string)),
        ("defaultEnabled", Value::is_boolean),
        ("dependencies", |value| is_list_of(value, is_dependency)),
        ("hooks", |value| {
            is_one_or_list_of(value, |hooks| is_json_path(hooks) || hooks.is_object())
        }),
        ("commands", is_commands),
        ("agents", |value| {
            is_one_or_list_of(value, |agent| is_path_ending(agent, ".md"))
        }),
        ("skills", |value| is_one_or_list_of(value, is_skill_path)),
        ("outputStyles", |value| is_one_or_list_of(value, is_path)),
        ("themes", |value| is_one_or_list_of(value, is_path)),
        ("workflows", |value| is_one_or_list_of(value, is_path)),
        ("mcpServers", |value| {
            is_one_or_list_of(value, |entry| is_servers(entry) || is_bundle(entry))
        }),
        ("lspServers", |value| is_one_or_list_of(value, is_servers)),
        ("monitors", |value| is_json_path(value) || value.is_array()),
        ("userConfig", is_user_config),
        ("channels", |value| is_list_of(value, Value::is_object)),
        ("settings", Value::is_object),
        ("types", is_types_path),
        ("experimental", is_experimental),
    ];
    for (member, check) in checks {
        if manifest.get(member).is_some_and(|value| !check(value)) {
            return Err(member);
        }
    }
    manifest.get("name").and_then(Value::as_str).ok_or("name")
}

// A plugin name as the schema takes it: text with no space and no control or bidirectional
// formatting character.
fn is_plugin_name(value: &Value) -> bool {
    value.as_str().is_some_and(|name| {
        !name.is_empty()
            && !name.chars().any(|c| {
                c == ' '
                    || c.is_control()
                    || matches!(
                        c,
                        '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
                    )
            })
    })
}

// An author as the schema takes it: an object with a non-empty `name`, and text where it names an
// email or an address.
fn is_author(value: &Value) -> bool {
    value.as_object().is_some_and(|author| {
        author
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty())
            && ["email", "url"]
                .into_iter()
                .all(|member| author.get(member).is_none_or(Value::is_string))
    })
}

fn is_url(value: &Value) -> bool {
    value.as_str().is_some_and(|text| Url::parse(text).is_ok())
}

fn is_list_of(value: &Value, is_item: fn(&Value) -> bool) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(is_item))
}

fn is_one_or_list_of(value: &Value, is_item: fn(&Value) -> bool) -> bool {
    is_item(value) || is_list_of(value, is_item)
}

// A dependency as the schema takes it: a plugin name as text, or an object naming the plugin and,
// where it names one, its marketplace.
fn is_dependency(value: &Value) -> bool {
    match value {
        Value::String(text) => DEPENDENCY_TEXT.is_match(text),
        Value::Object(dependency) => {
            let is_part = |part: &Value| {
                part.as_str()
                    .is_some_and(|part| DEPENDENCY_PART.is_match(part))
            };
            dependency.get("name").is_some_and(is_part)
                && dependency.get("marketplace").is_none_or(is_part)
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) => false,
    }
}

// A path relative to the plugin root, as the schema takes it: text starting `./`.
fn is_path(value: &Value) -> bool {
    value.as_str().is_some_and(|path| path.starts_with("./"))
}

fn is_path_ending(value: &Value, suffix: &str) -> bool {
    is_path(value) && value.as_str().is_some_and(|path| path.ends_with(suffix))
}

// A path to a JSON file, as the schema takes it.
fn is_json_path(value: &Value) -> bool {
    is_path_ending(value, ".json")
}

// A skill folder, as the schema takes it: the plugin root `.` or a path.
fn is_skill_path(value: &Value) -> bool {
    value.as_str() == Some(".") || is_path(value)
}

// Commands as the schema takes them: a path, a list of paths, or commands by name, each an
// object.
fn is_commands(value: &Value) -> bool {
    is_one_or_list_of(value, is_path)
        || value
            .as_object()
            .is_some_and(|commands| commands.values().all(Value::is_object))
}

// MCP or LSP servers as the schema takes them, past a bundle: a JSON file's path, or servers by
// name, each an object.
fn is_servers(value: &Value) -> bool {
    is_json_path(value)
        || value
            .as_object()
            .is_some_and(|servers| servers.values().all(Value::is_object))
}

// An MCP bundle as the schema takes it: a path or an address ending `.mcpb` or `.dxt`.
fn is_bundle(value: &Value) -> bool {
    value.as_str().is_some_and(|bundle| {
        BUNDLE_SUFFIXES
            .iter()
            .any(|suffix| bundle.ends_with(suffix))
            && (bundle.starts_with("./") || Url::parse(bundle).is_ok())
    })
}

// User options as the schema takes them: each keyed by a name a variable can take, each an object.
fn is_user_config(value: &Value) -> bool {
    value.as_object().is_some_and(|options| {
        options
            .iter()
            .all(|(key, option)| USER_CONFIG_KEY.is_match(key) && option.is_object())
    })
}

// A type contract as the schema takes it: a path to a `.d.ts` file with no `..` segment.
fn is_types_path(value: &Value) -> bool {
    is_path_ending(value, ".d.ts")
        && value
            .as_str()
            .is_some_and(|path| !path.split(['/', '\\']).any(|segment| segment == ".."))
}

// The experimental components as the schema takes them: anything but an object reads as absent; in
// an object, each component it knows has its form.
fn is_experimental(value: &Value) -> bool {
    let Some(experimental) = value.as_object() else {
        return true;
    };
    let is_component =
        |member: &str, check: fn(&Value) -> bool| experimental.get(member).is_none_or(check);
    is_component("themes", |value| is_one_or_list_of(value, is_path))
        && is_component("outputStyles", |value| is_one_or_list_of(value, is_path))
        && is_component("monitors", |value| is_json_path(value) || value.is_array())
        && is_component("syntaxHighlighting", Value::is_object)
        && is_component("evals", |value| is_one_or_list_of(value, Value::is_string))
}
