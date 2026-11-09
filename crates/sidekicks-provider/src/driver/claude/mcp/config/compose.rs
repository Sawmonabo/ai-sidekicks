//! The server entry Claude Code will hold for one binding after a write: the members it held
//! before, the other transport's members removed where the transport changes, and the submitted
//! members set, so every member the declaration does not model survives as it was.

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpServerConfigInput};
use sidekicks_contracts::wire::text::FreeFormText;

use super::{HTTP_TYPE, OAUTH_MEMBER, SSE_TYPE, STDIO_TYPE, URL_MEMBER};
use crate::driver::mcp_server::write::{
    McpServerEntry, McpServerObservedEntry, McpServerWriteRefusal, SubmittedMember,
    apply_submitted_member, provider_words_without_values, set_member,
};

/// The member of Claude Code's entry naming its transport, read as `stdio` where it is absent.
pub(super) const TYPE_MEMBER: &str = "type";

/// The member naming the program a `stdio` entry starts.
pub(super) const COMMAND_MEMBER: &str = "command";

/// The member listing the program's arguments.
pub(super) const ARGS_MEMBER: &str = "args";

/// The member holding the program's environment, values included.
pub(super) const ENV_MEMBER: &str = "env";

/// The member holding the headers sent with each request, values included.
pub(super) const HEADERS_MEMBER: &str = "headers";

/// The member of an entry's `oauth` naming the scopes a sign-in asks for, space-separated.
const OAUTH_SCOPES_MEMBER: &str = "scopes";

/// The members only an entry that starts a program holds, removed when it moves to an address.
const PROGRAM_MEMBERS: [&str; 3] = [COMMAND_MEMBER, ARGS_MEMBER, ENV_MEMBER];

/// The members only an entry that reaches an address holds, removed when it moves to a program.
const ADDRESS_MEMBERS: [&str; 2] = [URL_MEMBER, HEADERS_MEMBER];

/// The words a write of a switch, or over one, answers with: Claude Code's switch is the daemon's
/// own.
pub(super) const NO_SWITCH_WORDS: &str = "Claude Code keeps no switch for a server in its config.";

/// What one declaration submits, by the names of Claude Code's entry.
struct SubmittedMembers {
    /// The `type` the entry takes.
    transport_type: &'static str,
    /// The members of the transport the declaration does not submit.
    other_transport_members: &'static [&'static str],
    /// The members submitted, each set or cleared; a member left absent is not listed.
    members: Vec<SubmittedMember>,
    /// The scopes submitted; `None` keeps the held ones.
    oauth_scopes: Option<SubmittedScopes>,
}

/// The scopes one declaration submits.
enum SubmittedScopes {
    /// The scopes, space-joined.
    Set(String),
    /// No scopes, which clears the held ones.
    Cleared,
}

/// The entry Claude Code holds for a binding once `config` is written over `before`: `before`'s
/// members, the other transport's removed and `type` set where the transport changes, then each
/// submitted member set or removed; an add holds the submitted members alone, with `type` left
/// off a `stdio` entry as Claude Code's own add leaves it. Fails `Provider` over a switch, and
/// `EntryInvalid` for a member Claude Code does not read or a value that does not serialize.
pub(crate) fn compose_claude_mcp_entry(
    config: &McpServerConfigInput,
    before: &McpServerObservedEntry,
) -> Result<McpServerEntry, McpServerWriteRefusal> {
    let submitted = read_submitted_members(config)?;
    let mut members = match before {
        McpServerObservedEntry::Present(entry) => {
            let mut members = entry.members().clone();
            let held_type = match members.get(TYPE_MEMBER) {
                None => Some(STDIO_TYPE),
                Some(held) => held.as_str(),
            };
            if held_type != Some(submitted.transport_type) {
                for member in submitted.other_transport_members {
                    members.remove(*member);
                }
                members.insert(
                    TYPE_MEMBER.to_owned(),
                    Value::from(submitted.transport_type),
                );
            }
            members
        }
        McpServerObservedEntry::Absent if submitted.transport_type == STDIO_TYPE => Map::new(),
        McpServerObservedEntry::Absent => [(
            TYPE_MEMBER.to_owned(),
            Value::from(submitted.transport_type),
        )]
        .into_iter()
        .collect(),
        McpServerObservedEntry::Switch(_) => {
            return Err(McpServerWriteRefusal::Provider {
                words: provider_words_without_values(NO_SWITCH_WORDS),
            });
        }
    };
    for submitted_member in submitted.members {
        apply_submitted_member(&mut members, submitted_member);
    }
    if let Some(scopes) = submitted.oauth_scopes {
        set_oauth_scopes(&mut members, scopes);
    }
    Ok(McpServerEntry::from_members(members))
}

// Sets `scopes` as the `oauth` member's `scopes`, keeping its other members, or removes them for
// `Cleared`; an `oauth` that is no object is replaced by one holding the scopes alone.
fn set_oauth_scopes(members: &mut Map<String, Value>, scopes: SubmittedScopes) {
    match scopes {
        SubmittedScopes::Set(scopes) => {
            let oauth = members
                .entry(OAUTH_MEMBER)
                .or_insert_with(|| Value::Object(Map::new()));
            if !oauth.is_object() {
                *oauth = Value::Object(Map::new());
            }
            if let Value::Object(oauth) = oauth {
                oauth.insert(OAUTH_SCOPES_MEMBER.to_owned(), Value::from(scopes));
            }
        }
        SubmittedScopes::Cleared => {
            if let Some(Value::Object(oauth)) = members.get_mut(OAUTH_MEMBER) {
                oauth.remove(OAUTH_SCOPES_MEMBER);
            }
        }
    }
}

// The `type`, the other transport's members and the submitted members of `config`, by the names
// of Claude Code's entry. The switch is left out, since Claude Code's is the daemon's own, and a
// member Claude Code does not read is refused, set or cleared alike. The one reader of `config`'s
// members.
fn read_submitted_members(
    config: &McpServerConfigInput,
) -> Result<SubmittedMembers, McpServerWriteRefusal> {
    match config {
        McpServerConfigInput::Stdio {
            command,
            args,
            env,
            env_vars,
            enabled: _,
            required,
            startup_timeout_sec,
            tool_timeout_sec,
        } => {
            refuse_unread_members(&[
                (McpDeclaredConfigMember::EnvVars, env_vars.is_some()),
                (McpDeclaredConfigMember::Required, required.is_some()),
                (
                    McpDeclaredConfigMember::StartupTimeoutSec,
                    startup_timeout_sec.is_some(),
                ),
                (
                    McpDeclaredConfigMember::ToolTimeoutSec,
                    tool_timeout_sec.is_some(),
                ),
            ])?;
            Ok(SubmittedMembers {
                transport_type: STDIO_TYPE,
                other_transport_members: &ADDRESS_MEMBERS,
                members: [
                    set_member(COMMAND_MEMBER, Some(Some(command)))?,
                    set_member(ARGS_MEMBER, args.as_ref().map(Option::as_ref))?,
                    set_member(ENV_MEMBER, env.as_ref().map(Option::as_ref))?,
                ]
                .into_iter()
                .flatten()
                .collect(),
                oauth_scopes: None,
            })
        }
        McpServerConfigInput::Http {
            url,
            headers,
            bearer_token_env_var,
            env_http_headers,
            oauth_scopes,
            oauth_resource,
            enabled: _,
            required,
            startup_timeout_sec,
            tool_timeout_sec,
        }
        | McpServerConfigInput::Sse {
            url,
            headers,
            bearer_token_env_var,
            env_http_headers,
            oauth_scopes,
            oauth_resource,
            enabled: _,
            required,
            startup_timeout_sec,
            tool_timeout_sec,
        } => {
            refuse_unread_members(&[
                (
                    McpDeclaredConfigMember::BearerTokenEnvVar,
                    bearer_token_env_var.is_some(),
                ),
                (
                    McpDeclaredConfigMember::EnvHttpHeaders,
                    env_http_headers.is_some(),
                ),
                (
                    McpDeclaredConfigMember::OauthResource,
                    oauth_resource.is_some(),
                ),
                (McpDeclaredConfigMember::Required, required.is_some()),
                (
                    McpDeclaredConfigMember::StartupTimeoutSec,
                    startup_timeout_sec.is_some(),
                ),
                (
                    McpDeclaredConfigMember::ToolTimeoutSec,
                    tool_timeout_sec.is_some(),
                ),
            ])?;
            Ok(SubmittedMembers {
                transport_type: if matches!(config, McpServerConfigInput::Sse { .. }) {
                    SSE_TYPE
                } else {
                    HTTP_TYPE
                },
                other_transport_members: &PROGRAM_MEMBERS,
                members: [
                    set_member(URL_MEMBER, Some(Some(url)))?,
                    set_member(HEADERS_MEMBER, headers.as_ref().map(Option::as_ref))?,
                ]
                .into_iter()
                .flatten()
                .collect(),
                // Claude Code reads one space-separated string; no scopes clears it.
                oauth_scopes: oauth_scopes.as_ref().map(|scopes| {
                    match scopes
                        .as_ref()
                        .map(|scopes| {
                            scopes
                                .iter()
                                .map(FreeFormText::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .filter(|scopes| !scopes.is_empty())
                    {
                        Some(scopes) => SubmittedScopes::Set(scopes),
                        None => SubmittedScopes::Cleared,
                    }
                }),
            })
        }
    }
}

// Refuses the first member of `members` the declaration submits, each paired with whether it does.
fn refuse_unread_members(
    members: &[(McpDeclaredConfigMember, bool)],
) -> Result<(), McpServerWriteRefusal> {
    match members.iter().find(|(_member, is_submitted)| *is_submitted) {
        Some((member, _is_submitted)) => Err(McpServerWriteRefusal::EntryInvalid {
            words: provider_words_without_values(&format!(
                "Claude Code does not read a server's {} setting.",
                <&str>::from(*member)
            )),
        }),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::mcp::server::config::McpServerConfigInput;

    use super::compose_claude_mcp_entry;
    use crate::driver::mcp_server::write::{McpServerEntry, McpServerObservedEntry};

    // An update keeps every member the declaration does not model, a sign-in's included, and
    // changes only the one submitted. Killed by a remove-then-add and by an entry rewritten whole
    // from the declaration, each of which drops `alwaysAllow` and `oauth`.
    #[test]
    fn an_update_keeps_every_member_the_input_does_not_model() {
        let held = json!({
            "command": "npx",
            "args": ["docs-server"],
            "env": {"DOCS_TOKEN": "docs-token"},
            "alwaysAllow": ["x"],
            "oauth": {"clientId": "c"},
        });
        let config: McpServerConfigInput = serde_json::from_value(json!({
            "transport": "stdio", "command": "npx", "args": ["docs-server", "--verbose"]
        }))
        .expect("the test's declaration reads");

        let composed = compose_claude_mcp_entry(
            &config,
            &McpServerObservedEntry::Present(McpServerEntry::from_json(held.clone())),
        )
        .expect("the entry composes");

        let mut expected = held;
        expected["args"] = json!(["docs-server", "--verbose"]);
        assert_eq!(composed, McpServerEntry::from_json(expected));
    }

    // Submitted scopes land as `oauth.scopes`, space-joined, beside the `oauth` members held, and
    // `null` removes them alone. Killed by the scopes refused, by `oauth` rewritten whole (the
    // client id is lost) and by the scopes written as a list.
    #[rstest]
    #[case::set(json!(["read", "write"]), json!({"clientId": "c", "scopes": "read write"}))]
    #[case::cleared(json!(null), json!({"clientId": "c"}))]
    fn submitted_scopes_are_written_into_the_oauth_member(
        #[case] scopes: serde_json::Value,
        #[case] expected_oauth: serde_json::Value,
    ) {
        let held = json!({
            "type": "http",
            "url": "https://docs.example.test/mcp",
            "oauth": {"clientId": "c", "scopes": "old"},
        });
        let config: McpServerConfigInput = serde_json::from_value(json!({
            "transport": "http", "url": "https://docs.example.test/mcp", "oauthScopes": scopes
        }))
        .expect("the test's declaration reads");

        let composed = compose_claude_mcp_entry(
            &config,
            &McpServerObservedEntry::Present(McpServerEntry::from_json(held.clone())),
        )
        .expect("the scopes are written");

        let mut expected = held;
        expected["oauth"] = expected_oauth;
        assert_eq!(composed, McpServerEntry::from_json(expected));
    }
}
