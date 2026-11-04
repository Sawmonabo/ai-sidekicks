//! The checks a mutation passes before anything is written or any driver is called: the name rule
//! and declared transports and members of the binding's provider, the one name a provider that
//! emulates `local` servers keeps across its user file, and the binding a removal or a switch
//! addresses being declared.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the mutation service checks each mutation before its intent is written"
    )
)]

use std::path::Path;

use sidekicks_contracts::mcp::server::config::McpServerConfigInput;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpWritableBindingRef};
use sidekicks_provider::driver::descriptor_of;

use crate::errors::McpRefusal;

/// A mutation as the preflight reads it.
pub(crate) enum McpMutationCheck<'a> {
    /// Adds a binding or changes its declaration.
    Upsert {
        /// The binding written.
        binding: &'a McpWritableBindingRef,
        /// The declaration submitted for it.
        config: &'a McpServerConfigInput,
    },
    /// Removes a binding.
    Remove {
        /// The binding removed.
        binding: &'a McpWritableBindingRef,
    },
    /// Switches a binding on or off.
    SetEnabled {
        /// The binding switched.
        binding: &'a McpServerBindingRef,
    },
}

/// Whether `check` may go ahead, given `declared`, every binding its provider declares across
/// every root. Refuses an upsert as `ServerConfigInvalid` and a removal or switch of a binding not
/// declared as `ServerNotFound`; it reads nothing and writes nothing.
pub(crate) fn check_mutation(
    check: &McpMutationCheck<'_>,
    declared: &[McpServerBindingRef],
) -> Result<(), McpRefusal> {
    match check {
        McpMutationCheck::Upsert { binding, config } => check_upsert(binding, config, declared),
        McpMutationCheck::Remove { binding } => {
            check_declared_binding(&binding.binding(), declared)
        }
        McpMutationCheck::SetEnabled { binding } => check_declared_binding(binding, declared),
    }
}

// An upsert's name, then its declaration against what the provider takes, then, where the
// provider keeps `local` servers in its user file, the name's one use across that file.
fn check_upsert(
    binding: &McpWritableBindingRef,
    config: &McpServerConfigInput,
    declared: &[McpServerBindingRef],
) -> Result<(), McpRefusal> {
    let binding = binding.binding();
    let Some(descriptor) = descriptor_of(binding.provider().as_str()) else {
        return Err(config_invalid("no provider has this id".to_owned()));
    };
    descriptor
        .mcp_server_names
        .check(binding.server_name())
        .map_err(|refusal| config_invalid(refusal.to_string()))?;
    config
        .check_declared(&descriptor.mcp_declaration())
        .map_err(|error| config_invalid(error.to_string()))?;
    if !descriptor.is_mcp_local_scope_emulated || user_file_holder(&binding).is_none() {
        return Ok(());
    }
    match declared
        .iter()
        .filter(|other| **other != binding && other.server_name() == binding.server_name())
        .find_map(user_file_holder)
    {
        Some(holder) => Err(config_invalid(format!(
            "the name is already {holder}, and the provider keeps one server of a name across its \
             user file"
        ))),
        None => Ok(()),
    }
}

// A removal's or a switch's binding, which must be one its provider declares.
fn check_declared_binding(
    binding: &McpServerBindingRef,
    declared: &[McpServerBindingRef],
) -> Result<(), McpRefusal> {
    if descriptor_of(binding.provider().as_str()).is_some() && declared.contains(binding) {
        Ok(())
    } else {
        Err(McpRefusal::ServerNotFound {
            binding: Box::new(binding.clone()),
        })
    }
}

// Whom the binding's entry stands for, where the provider emulates `local` servers in its user
// file: a user server, or a local server of a project named by its root's last folder name and
// never by its path; `None` for a binding whose entry is not in that file.
fn user_file_holder(binding: &McpServerBindingRef) -> Option<String> {
    match binding {
        McpServerBindingRef::User { .. } => Some("a user server".to_owned()),
        McpServerBindingRef::Local { scope_ref, .. } => {
            Some(match Path::new(scope_ref.as_str()).file_name() {
                Some(folder) => {
                    format!("a local server of the project {}", folder.to_string_lossy())
                }
                None => "a local server of another project".to_owned(),
            })
        }
        McpServerBindingRef::Project { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => None,
    }
}

fn config_invalid(reason: String) -> McpRefusal {
    McpRefusal::ServerConfigInvalid { reason }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpWritableBindingRef};

    use super::{McpMutationCheck, check_mutation};
    use crate::errors::McpRefusal;

    /// What a check answers, as each case expects it.
    #[derive(Debug)]
    enum Verdict {
        Allowed,
        /// Refused as invalid, the reason holding the first text and, where given, not the second.
        Invalid(&'static str, Option<&'static str>),
        NotFound,
    }

    fn binding_value(provider: &str, scope: &str, root: Option<&str>) -> Value {
        let mut binding = json!({ "scope": scope, "provider": provider, "serverName": "github" });
        if let Some(root) = root {
            binding["scopeRef"] = json!(root);
        }
        binding
    }

    fn assert_verdict(result: Result<(), McpRefusal>, expected: &Verdict) {
        match (result, expected) {
            (Ok(()), Verdict::Allowed)
            | (Err(McpRefusal::ServerNotFound { .. }), Verdict::NotFound) => {}
            (Err(McpRefusal::ServerConfigInvalid { reason }), Verdict::Invalid(naming, never)) => {
                assert!(reason.contains(naming), "{reason}");
                if let Some(never) = never {
                    assert!(!reason.contains(never), "{reason}");
                }
            }
            (result, expected) => panic!("{result:?} where {expected:?} was expected"),
        }
    }

    /// An upsert is refused for an unknown provider, a name or a declaration the provider does not
    /// take, and, on a provider that keeps `local` servers in its user file, a name another user or
    /// local binding holds there, named by its project's last folder name alone.
    #[rstest]
    #[case::undeclared_member(
        binding_value("claude", "user", None),
        json!({ "transport": "stdio", "command": "npx", "envVars": ["HOME"] }),
        vec![],
        Verdict::Invalid("envVars", None),
    )]
    #[case::undeclared_transport(
        binding_value("codex", "user", None),
        json!({ "transport": "sse", "url": "https://example.com/sse" }),
        vec![],
        Verdict::Invalid("sse", None),
    )]
    #[case::unknown_provider(
        binding_value("nobody", "user", None),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![],
        Verdict::Invalid("provider", None),
    )]
    #[case::kept_name(
        json!({ "scope": "user", "provider": "claude", "serverName": "sidekicks" }),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![],
        Verdict::Invalid("keeps", None),
    )]
    #[case::local_beside_another_projects_local(
        binding_value("codex", "local", Some("/a/one")),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![binding_value("codex", "local", Some("/b/two"))],
        Verdict::Invalid("two", Some("/b")),
    )]
    #[case::user_beside_a_local(
        binding_value("codex", "user", None),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![binding_value("codex", "local", Some("/b/two"))],
        Verdict::Invalid("two", Some("/b")),
    )]
    #[case::local_beside_a_user(
        binding_value("codex", "local", Some("/a/one")),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![binding_value("codex", "user", None)],
        Verdict::Invalid("user server", None),
    )]
    #[case::update_of_itself(
        binding_value("codex", "local", Some("/a/one")),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![binding_value("codex", "local", Some("/a/one"))],
        Verdict::Allowed,
    )]
    #[case::project_beside_a_local(
        binding_value("codex", "project", Some("/a/one")),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![binding_value("codex", "local", Some("/b/two"))],
        Verdict::Allowed,
    )]
    #[case::local_beside_a_user_where_local_is_native(
        binding_value("claude", "local", Some("/a/one")),
        json!({ "transport": "stdio", "command": "npx" }),
        vec![binding_value("claude", "user", None)],
        Verdict::Allowed,
    )]
    fn an_upsert_is_checked_before_anything_is_written(
        #[case] binding: Value,
        #[case] config: Value,
        #[case] declared: Vec<Value>,
        #[case] expected: Verdict,
    ) {
        let binding: McpWritableBindingRef = serde_json::from_value(binding).expect("a binding");
        let config = serde_json::from_value(config).expect("a declaration");
        let declared: Vec<McpServerBindingRef> = declared
            .into_iter()
            .map(|binding| serde_json::from_value(binding).expect("a binding"))
            .collect();
        let check = McpMutationCheck::Upsert {
            binding: &binding,
            config: &config,
        };
        assert_verdict(check_mutation(&check, &declared), &expected);
    }

    /// A removal or a switch goes ahead only for a binding its known provider declares.
    #[rstest]
    #[case::remove_declared(false, "codex", true, Verdict::Allowed)]
    #[case::remove_undeclared(false, "codex", false, Verdict::NotFound)]
    #[case::remove_of_unknown_provider(false, "nobody", true, Verdict::NotFound)]
    #[case::switch_declared(true, "claude", true, Verdict::Allowed)]
    #[case::switch_undeclared(true, "claude", false, Verdict::NotFound)]
    #[case::switch_of_unknown_provider(true, "nobody", true, Verdict::NotFound)]
    fn a_removal_or_switch_needs_a_declared_binding(
        #[case] is_switch: bool,
        #[case] provider: &str,
        #[case] is_declared: bool,
        #[case] expected: Verdict,
    ) {
        let value = binding_value(provider, "local", Some("/a/one"));
        let writable: McpWritableBindingRef =
            serde_json::from_value(value.clone()).expect("a binding");
        let any_scope: McpServerBindingRef = serde_json::from_value(value).expect("a binding");
        let declared = if is_declared {
            vec![any_scope.clone()]
        } else {
            Vec::new()
        };
        let check = if is_switch {
            McpMutationCheck::SetEnabled {
                binding: &any_scope,
            }
        } else {
            McpMutationCheck::Remove { binding: &writable }
        };
        assert_verdict(check_mutation(&check, &declared), &expected);
    }
}
