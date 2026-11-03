//! The forms Codex writes a name in when it writes text, and the names it gives a session's tool
//! servers' tools.

use std::collections::{HashMap, HashSet};

use sha1::{Digest as _, Sha1};

use crate::driver::written_name::{WrittenNameForm, WrittenNameKind, WrittenNameSpelling};

/// Every form Codex writes a name of each kind in: a command as `/name`, a skill as `$name` and a
/// tool server's tool as `mcp__<server>__<tool>`, each character of the server's name and the
/// tool's outside `A-Za-z0-9_` written as `_` and a name past 128 bytes cut as Codex cuts it. It
/// writes no agent and no tool server's prompt.
pub(super) const CODEX_WRITTEN_NAME_FORMS: [WrittenNameForm; 3] = [
    WrittenNameForm {
        kind: WrittenNameKind::Command,
        opening: "/",
        joiner: "",
        closing: "",
        server_spelling: WrittenNameSpelling::Unchanged,
        name_spelling: WrittenNameSpelling::Unchanged,
        fit: None,
    },
    WrittenNameForm {
        kind: WrittenNameKind::Skill,
        opening: "$",
        joiner: "",
        closing: "",
        server_spelling: WrittenNameSpelling::Unchanged,
        name_spelling: WrittenNameSpelling::Unchanged,
        fit: None,
    },
    WrittenNameForm {
        kind: WrittenNameKind::ToolServerTool,
        opening: TOOL_NAMESPACE_PREFIX,
        joiner: TOOL_NAME_DELIMITER,
        closing: "",
        server_spelling: WrittenNameSpelling::ResponsesToolNameSafe,
        name_spelling: WrittenNameSpelling::ResponsesToolNameSafe,
        fit: Some(write_tool_name),
    },
];

const TOOL_NAMESPACE_PREFIX: &str = "mcp__";
const TOOL_NAME_DELIMITER: &str = "__";
const MAX_TOOL_NAME_LENGTH: usize = 128;
const TOOL_NAME_HASH_LENGTH: usize = 12;

/// The name Codex gives each of a session's tool servers' tools, in the order given, each given as
/// its server's name and the tool's: `mcp__<server>__<tool>` spelled as the form spells it, a
/// server or tool name two servers or tools spell alike suffixed with a hash of its own, and a name
/// past 128 bytes cut to fit with a hash.
pub(crate) fn qualify_codex_tool_names(tools: &[(&str, &str)]) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen_identities = HashSet::new();
    for &(server, tool) in tools {
        let tool_identity = tool_identity(server, tool);
        if !seen_identities.insert(tool_identity.clone()) {
            continue;
        }
        let mut spelled_server = String::new();
        WrittenNameSpelling::ResponsesToolNameSafe.spell_onto(&mut spelled_server, server);
        let namespace = if spelled_server.starts_with(TOOL_NAMESPACE_PREFIX) {
            spelled_server
        } else {
            format!("{TOOL_NAMESPACE_PREFIX}{spelled_server}")
        };
        let mut name = String::new();
        WrittenNameSpelling::ResponsesToolNameSafe.spell_onto(&mut name, tool);
        candidates.push(ToolNameCandidate {
            namespace_identity: namespace_identity(server),
            tool_identity,
            namespace,
            name,
        });
    }

    let mut namespace_identities = HashMap::<String, HashSet<String>>::new();
    for candidate in &candidates {
        namespace_identities
            .entry(candidate.namespace.clone())
            .or_default()
            .insert(candidate.namespace_identity.clone());
    }
    for candidate in &mut candidates {
        if namespace_identities[&candidate.namespace].len() > 1 {
            candidate.namespace =
                append_namespace_hash_suffix(&candidate.namespace, &candidate.namespace_identity);
        }
    }

    let mut tool_identities = HashMap::<(String, String), HashSet<String>>::new();
    for candidate in &candidates {
        tool_identities
            .entry((candidate.namespace.clone(), candidate.name.clone()))
            .or_default()
            .insert(candidate.tool_identity.clone());
    }
    for candidate in &mut candidates {
        if tool_identities[&(candidate.namespace.clone(), candidate.name.clone())].len() > 1 {
            candidate.name = format!(
                "{}{}",
                candidate.name,
                hash_suffix(&candidate.tool_identity)
            );
        }
    }

    candidates.sort_by(|left, right| left.tool_identity.cmp(&right.tool_identity));
    let mut used_names = HashSet::new();
    let written: HashMap<String, String> = candidates
        .into_iter()
        .map(|candidate| {
            let (namespace, name) = unique_name_parts(
                &candidate.namespace,
                &candidate.name,
                &candidate.tool_identity,
                &mut used_names,
            );
            (
                candidate.tool_identity,
                format!("{namespace}{TOOL_NAME_DELIMITER}{name}"),
            )
        })
        .collect();
    tools
        .iter()
        .map(|&(server, tool)| written[&tool_identity(server, tool)].clone())
        .collect()
}

// One tool's name as Codex writes it in a session with no other tool.
fn write_tool_name(server: &str, tool: &str) -> String {
    qualify_codex_tool_names(&[(server, tool)]).swap_remove(0)
}

// One tool's parts before Codex makes its name unique.
struct ToolNameCandidate {
    namespace_identity: String,
    tool_identity: String,
    namespace: String,
    name: String,
}

// What Codex hashes for a tool server: its name, its name again as the namespace and no connector.
fn namespace_identity(server: &str) -> String {
    format!("{server}\0{server}\0")
}

// What Codex hashes for a tool: its server's identity, then the tool's name twice.
fn tool_identity(server: &str, tool: &str) -> String {
    format!("{}\0{tool}\0{tool}", namespace_identity(server))
}

// `_` and the first 12 hex digits of the SHA-1 of `identity`.
fn hash_suffix(identity: &str) -> String {
    let hash = base16ct::lower::encode_string(&Sha1::digest(identity.as_bytes()));
    format!("_{}", &hash[..TOOL_NAME_HASH_LENGTH])
}

// The namespace with its hash suffix, set before a trailing `__` where it ends in one.
fn append_namespace_hash_suffix(namespace: &str, identity: &str) -> String {
    match namespace.strip_suffix(TOOL_NAME_DELIMITER) {
        Some(stem) => format!("{stem}{}{TOOL_NAME_DELIMITER}", hash_suffix(identity)),
        None => format!("{namespace}{}", hash_suffix(identity)),
    }
}

// The parts as given where their joined name fits and is unused, else cut to fit with a hash of
// the identity, and of the identity and an attempt count while the cut one is taken.
fn unique_name_parts(
    namespace: &str,
    name: &str,
    identity: &str,
    used_names: &mut HashSet<String>,
) -> (String, String) {
    let joined = format!("{namespace}{name}");
    if joined.len() + TOOL_NAME_DELIMITER.len() <= MAX_TOOL_NAME_LENGTH && used_names.insert(joined)
    {
        return (namespace.to_owned(), name.to_owned());
    }
    let mut attempt = 0_u32;
    loop {
        let hash_input = if attempt == 0 {
            identity.to_owned()
        } else {
            format!("{identity}\0{attempt}")
        };
        let (namespace, name) = fit_name_parts_with_hash(namespace, name, &hash_input);
        if used_names.insert(format!("{namespace}{name}")) {
            return (namespace, name);
        }
        attempt = attempt.saturating_add(1);
    }
}

// The name cut to leave room for the hash suffix, or, where the namespace leaves no room for the
// suffix, the namespace cut and the suffix alone as the name.
fn fit_name_parts_with_hash(namespace: &str, name: &str, hash_input: &str) -> (String, String) {
    let suffix = hash_suffix(hash_input);
    let max_name_length =
        MAX_TOOL_NAME_LENGTH.saturating_sub(namespace.len() + TOOL_NAME_DELIMITER.len());
    if max_name_length >= suffix.len() {
        let kept: String = name.chars().take(max_name_length - suffix.len()).collect();
        return (namespace.to_owned(), format!("{kept}{suffix}"));
    }
    let max_namespace_length =
        MAX_TOOL_NAME_LENGTH.saturating_sub(suffix.len() + TOOL_NAME_DELIMITER.len());
    (
        namespace.chars().take(max_namespace_length).collect(),
        suffix,
    )
}

#[cfg(test)]
mod tests {
    use super::qualify_codex_tool_names;
    use crate::driver::descriptor_of;
    use crate::driver::written_name::WrittenNameKind;

    // The suffix is the SHA-1 of `s\0s\0\0<tool>\0<tool>`, cut to 12 hex digits. Killed by the
    // cut dropped (the 200-character name written whole) or cut without its hash.
    #[test]
    fn codex_cuts_a_tool_name_past_128_bytes_to_fit_with_a_hash() {
        let descriptor = descriptor_of("codex").expect("the provider is registered");
        let form = descriptor
            .written_name_forms
            .iter()
            .find(|form| form.kind == WrittenNameKind::ToolServerTool)
            .expect("Codex writes a tool server's tool");

        let written = form.write(Some("s"), &"t".repeat(200));

        assert_eq!(written, format!("mcp__s__{}_5d9d900c5a30", "t".repeat(107)));
        assert_eq!(written.len(), 128);
    }

    // Each suffix is the SHA-1 of the server's `<server>\0<server>\0`, cut to 12 hex digits.
    // Killed by the namespace hash dropped (both written `mcp__my_server__search`) or hashed over
    // the spelled name rather than each server's own.
    #[test]
    fn two_servers_that_spell_alike_get_a_hash_of_their_own() {
        let written = qualify_codex_tool_names(&[("my-server", "search"), ("my.server", "search")]);

        assert_eq!(
            written,
            [
                "mcp__my_server_497a8b629ad2__search",
                "mcp__my_server_84cd56981196__search"
            ]
        );
    }
}
