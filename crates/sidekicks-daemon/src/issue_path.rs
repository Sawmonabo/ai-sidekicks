//! garde's issue paths in the wire's names: each step of a check's path is resolved against the
//! JSON the checked value was read from, so a refusal names members as the message spells them.

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::jsonrpc::issue::IssuePathSegment;

/// What one step of garde's path is, as garde's `serde` form names it.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum CheckPathStepKind {
    /// A wrapper's one inner value, which adds no step.
    None,
    /// A field's Rust name or a map's key.
    Key,
    /// An index into a list or a tuple.
    Index,
}

/// The wire path of a garde fault at `check_path` in the value read from `received`. A member step
/// keeps the name `received` holds verbatim (a map key, a field serde names alike), else serde's
/// camelCase of the field where `received` holds that; a step neither resolves (a member serde
/// renamed) ends the path at its parent. An index into a tuple serde writes as its one field (a
/// newtype) adds no step.
pub(crate) fn resolve_issue_path(
    check_path: &garde::Path,
    received: &Value,
) -> Vec<IssuePathSegment> {
    let steps: Vec<(CheckPathStepKind, String)> = serde_json::to_value(check_path)
        .and_then(serde_json::from_value)
        .expect("garde writes a path as a list of kind and component pairs");
    let mut at = received;
    let mut segments = Vec::with_capacity(steps.len());
    for (kind, component) in steps {
        match kind {
            CheckPathStepKind::None => {}
            CheckPathStepKind::Key => {
                let Some((name, member)) = member_of(at, component) else {
                    break;
                };
                segments.push(IssuePathSegment::Member(name));
                at = member;
            }
            CheckPathStepKind::Index => {
                let Value::Array(elements) = at else {
                    continue;
                };
                let index: usize = component.parse().expect("garde writes an index as digits");
                let Some(element) = elements.get(index) else {
                    break;
                };
                segments.push(IssuePathSegment::index(index));
                at = element;
            }
        }
    }
    segments
}

// The member `received` holds for garde's key: the key as written, else its serde camelCase.
fn member_of(received: &Value, key: String) -> Option<(String, &Value)> {
    let Value::Object(members) = received else {
        return None;
    };
    if let Some(member) = members.get(&key) {
        return Some((key, member));
    }
    let camel_case = serde_camel_case(&key);
    let member = members.get(&camel_case)?;
    Some((camel_case, member))
}

// serde's `rename_all = "camelCase"` of a snake_case field: each `_` dropped and the letter after
// it raised, the first letter lowered.
fn serde_camel_case(field: &str) -> String {
    let mut pascal_case = String::with_capacity(field.len());
    let mut is_word_start = true;
    for character in field.chars() {
        if character == '_' {
            is_word_start = true;
        } else if is_word_start {
            pascal_case.push(character.to_ascii_uppercase());
            is_word_start = false;
        } else {
            pascal_case.push(character);
        }
    }
    let mut characters = pascal_case.chars();
    characters.next().map_or_else(String::new, |first| {
        first.to_ascii_lowercase().to_string() + characters.as_str()
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Deserialize;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::issue::IssuePathSegment;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::resolve_issue_path;

    #[derive(Deserialize, garde::Validate)]
    #[serde(rename_all = "camelCase")]
    struct Registry {
        #[garde(dive)]
        servers: BTreeMap<String, Server>,
    }

    #[derive(Deserialize, garde::Validate)]
    #[serde(rename_all = "camelCase")]
    struct Server {
        #[serde(rename = "type")]
        #[garde(length(min = 1))]
        transport: String,
        #[garde(dive)]
        remote_hosts: Vec<RemoteHost>,
    }

    #[derive(Deserialize, garde::Validate)]
    #[serde(rename_all = "camelCase")]
    struct RemoteHost {
        #[garde(length(max = 4))]
        host_name: String,
    }

    #[test]
    fn names_a_fault_in_wire_names_and_stops_at_a_renamed_member() {
        let received = json!({
            "servers": {
                "ssh_key": { "type": "", "remoteHosts": [{ "hostName": "a-long-host" }] },
            },
        });
        let registry: Registry = serde_json::from_value(received.clone()).expect("the shape reads");
        let report = garde::Validate::validate(&registry).expect_err("both checks fail");
        let mut paths: Vec<Vec<IssuePathSegment>> = report
            .iter()
            .map(|(check_path, _)| resolve_issue_path(check_path, &received))
            .collect();
        paths.sort_by_key(Vec::len);
        let member = |name: &str| IssuePathSegment::Member(name.to_owned());
        assert_eq!(
            paths,
            [
                // `transport` is sent as `type`, so the path ends at the server, its key as sent.
                vec![member("servers"), member("ssh_key")],
                vec![
                    member("servers"),
                    member("ssh_key"),
                    member("remoteHosts"),
                    IssuePathSegment::Index(SafeInt::ZERO),
                    member("hostName"),
                ],
            ],
        );
    }
}
