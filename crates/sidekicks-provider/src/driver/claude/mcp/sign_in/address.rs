//! The whole address a Claude Code server's entry declares, read from the same entry a sign-in
//! through Claude Code copies, its `url` filled as Claude Code fills it before it connects.

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::config::McpServerAddress;

use super::{ClaudeMcpSignInSources, read_sign_in_entry};
use crate::driver::claude::mcp::config::{ClaudeServerEntryReader, URL_MEMBER};
use crate::driver::claude::mcp::machine_probe::variables::expand_remote_address;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading, NoPersonServerEntry,
};

/// The text that opens a variable in an entry's `url`, which one left unfilled still holds.
const VARIABLE_OPENING: &str = "${";

/// Reads the whole address each of `requests`' server entries declares, in the requests' order,
/// each `url` filled from the environment `environment_of` composes for its request, an
/// organization's server read from the administrator's MCP file's entry where one declares it;
/// each of the person's files is parsed once for the whole batch. A reading fails with
/// [`DriverError::NoPersonServerEntry`] for a connector, an organization's server the file does not
/// declare read for no account, and an entry that is gone or names no `url`, and as the entry's
/// read or its environment's composition fails.
pub(crate) async fn read_claude_server_addresses(
    sources: &ClaudeMcpSignInSources<'_>,
    requests: Vec<McpServerAddressRead>,
    environment_of: impl Fn(&McpServerAddressRead) -> Result<Vec<(String, String)>, DriverError>,
) -> Vec<Result<McpServerAddressReading, DriverError>> {
    let mut entries = ClaudeServerEntryReader::new(&sources.person, &sources.plugin_home);
    let mut readings = Vec::with_capacity(requests.len());
    for request in requests {
        let reading = match read_sign_in_entry(
            sources,
            &mut entries,
            &request.binding,
            request.provider_account_id.as_ref(),
        )
        .await
        {
            Ok(entry) => environment_of(&request)
                .map(|environment| address_reading(&entry, &environment, &request)),
            Err(error) => Err(error),
        };
        readings.push(reading.and_then(|reading| reading));
    }
    readings
}

// The whole address `entry` declares for `request`'s binding, its `url` filled from `environment`.
fn address_reading(
    entry: &Map<String, Value>,
    environment: &[(String, String)],
    request: &McpServerAddressRead,
) -> Result<McpServerAddressReading, DriverError> {
    let Some(url) = entry.get(URL_MEMBER).and_then(Value::as_str) else {
        return Err(DriverError::from(NoPersonServerEntry {
            binding: request.binding.clone(),
        }));
    };
    let filled = expand_remote_address(url, environment);
    // A variable with no value and no default stays as written, which a host can still parse.
    if filled.contains(VARIABLE_OPENING) {
        return Ok(McpServerAddressReading::Unreadable);
    }
    Ok(McpServerAddress::new(&filled).map_or(
        McpServerAddressReading::Unreadable,
        McpServerAddressReading::Declared,
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::machine::settings::EnvironmentRow;
    use sidekicks_contracts::mcp::server::McpServerBindingRef;

    use super::super::tests::{
        PERSON_CONFIG, SERVER_NAME, driver_on_environment, name, user_binding,
    };
    use super::read_claude_server_addresses;
    use crate::driver::DriverServices;
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::session::scripted::driver::ScriptedDriver;
    use crate::driver::contract::error::DriverError;
    use crate::driver::contract::sign_in::{McpServerAddressRead, McpServerAddressReading};
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A read of `binding`'s address for the test account, at no project root, its project's rows
    // `project_rows`.
    fn address_read(
        binding: McpServerBindingRef,
        project_rows: Vec<EnvironmentRow>,
    ) -> McpServerAddressRead {
        McpServerAddressRead {
            binding,
            provider_account_id: Some(test_provider_account_id()),
            root_folder: None,
            every_project_rows: Vec::new(),
            project_rows,
        }
    }

    // A person's entry is read whole, its user name and query kept, and its `url` filled from the
    // driver's base environment with the read's rows over it, as Claude Code fills it: a default
    // where the variable is unset, the value where it is set, a project's row's value where only
    // the row sets it, and a variable with no value and no default left unreadable. Killed by
    // answering the stripped address (the user name or query lost), by removing the expansion
    // (`expand_remote_address(url, environment)` replaced with `url.to_owned()` fails the default
    // case), by answering a text that is not an address as `Declared`, and by filling from the base
    // environment alone (the row case reads unreadable).
    #[rstest]
    #[case::user_name_and_query_kept(
        &[],
        &[],
        "https://user@docs.example.test/mcp?key=k",
        Some("https://user@docs.example.test/mcp?key=k")
    )]
    #[case::a_default_where_unset(
        &[],
        &[],
        "${API_BASE_URL:-https://docs.example.test}/mcp",
        Some("https://docs.example.test/mcp")
    )]
    #[case::the_value_where_set(
        &[("API_BASE_URL", "https://other.example.test")],
        &[],
        "${API_BASE_URL:-https://docs.example.test}/mcp",
        Some("https://other.example.test/mcp")
    )]
    #[case::a_project_rows_value(
        &[],
        &[("TENANT", "acme")],
        "https://${TENANT}.example.test/mcp",
        Some("https://acme.example.test/mcp")
    )]
    #[case::a_variable_with_no_value(&[], &[], "https://${TENANT}.example.test/mcp", None)]
    #[tokio::test]
    async fn a_claude_entry_is_read_whole_with_its_variables_filled(
        #[case] variables: &[(&str, &str)],
        #[case] project_rows: &[(&str, &str)],
        #[case] declared_url: &str,
        #[case] expected: Option<&str>,
    ) {
        let scripted = ScriptedDriver::new();
        std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
        std::fs::write(
            scripted.home.join(".claude.json"),
            json!({"mcpServers": {SERVER_NAME: {"type": "http", "url": declared_url}}}).to_string(),
        )
        .expect("the person's config is written");
        let base_environment: Vec<(String, String)> =
            std::iter::once(("HOME".to_owned(), scripted.home.display().to_string()))
                .chain(
                    variables
                        .iter()
                        .map(|(variable, value)| ((*variable).to_owned(), (*value).to_owned())),
                )
                .collect();
        let driver = driver_on_environment(
            &DriverServices {
                base_environment: Arc::from(base_environment),
                ..scripted.services
            },
            &scripted.starts,
            &scripted.engine,
        );

        let reading = driver
            .read_mcp_server_addresses(vec![address_read(
                user_binding(),
                EnvironmentRow::test_rows(project_rows),
            )])
            .await
            .pop()
            .expect("one reading answers one request")
            .expect("the entry reads");

        match (&reading, expected) {
            (McpServerAddressReading::Declared(address), Some(expected)) => {
                assert_eq!(address.as_str(), expected);
            }
            (McpServerAddressReading::Unreadable, None) => {}
            (reading, expected) => panic!("expected {expected:?}, read {reading:?}"),
        }
    }

    // A connector's sign-in is the account's own, so it has no entry of the person's to read an
    // address from. Killed by reading an entry for a connector.
    #[tokio::test]
    async fn a_connector_has_no_address_of_the_persons() {
        let scripted = ScriptedDriver::new();
        std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
        std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
            .expect("the person's config is written");
        let connector = McpServerBindingRef::Connector {
            provider: DESCRIPTOR.provider_id(),
            scope_ref: test_provider_account_id(),
            server_name: name(),
        };

        let refused = scripted
            .driver
            .read_mcp_server_addresses(vec![address_read(connector.clone(), Vec::new())])
            .await
            .pop()
            .expect("one reading answers one request");

        assert!(
            matches!(
                &refused,
                Err(DriverError::NoPersonServerEntry(no_entry)) if no_entry.binding == connector
            ),
            "a connector reads the no-entry arm, not {refused:?}"
        );
    }

    // A server of the administrator's MCP file is read from the file's entry, its `url` filled,
    // whether or not the organization's managed settings declare the same name, with no account
    // read. Killed by answering `Unreadable` for it, by reading the organization's entry
    // first, and by leaving the file's `${VAR}` unfilled.
    #[rstest]
    #[case::file_alone(false)]
    #[case::shared_name(true)]
    #[tokio::test]
    async fn a_managed_file_server_is_read_whole(#[case] is_shared_name: bool) {
        let scripted = ScriptedDriver::new();
        if is_shared_name {
            scripted.starts.script_account_servers(
                json!({"mcpServers": []}),
                json!({"effective": {"managedMcpServers": {
                    SERVER_NAME: {"type": "http", "url": "https://org.example.test/mcp"},
                }}}),
            );
        }
        let servers: Map<String, Value> = serde_json::from_value(json!({
            SERVER_NAME: {"type": "http", "url": "https://${HOST:-docs.example.test}/mcp?key=k"},
        }))
        .expect("the file's servers are an object");
        let managed = McpServerBindingRef::Managed {
            provider: DESCRIPTOR.provider_id(),
            server_name: name(),
        };

        let reading = read_claude_server_addresses(
            &scripted.driver.sign_in_sources_for(Some(servers)).await,
            vec![address_read(managed, Vec::new())],
            |_| Ok(scripted.driver.sources.base_environment.to_vec()),
        )
        .await
        .pop()
        .expect("one reading answers one request")
        .expect("the file's entry reads");

        let McpServerAddressReading::Declared(address) = &reading else {
            panic!("the file's address is declared, not {reading:?}");
        };
        assert_eq!(address.as_str(), "https://docs.example.test/mcp?key=k");
        assert_eq!(scripted.starts.take_account_servers_read_count(), 0);
    }

    // An organization's server whose managed settings entry carries `oauth`, with no file
    // deployed, is read at its whole address. Killed by the organization's entries keeping only
    // what a probe can send.
    #[tokio::test]
    async fn a_managed_settings_server_signed_in_by_its_owner_is_read() {
        let scripted = ScriptedDriver::new();
        scripted.starts.script_account_servers(
            json!({"mcpServers": []}),
            json!({"effective": {"managedMcpServers": {
                SERVER_NAME: {
                    "type": "http",
                    "url": "https://docs.example.test/mcp",
                    "oauth": {"clientId": "owner-client"},
                },
            }}}),
        );
        let managed = McpServerBindingRef::Managed {
            provider: DESCRIPTOR.provider_id(),
            server_name: name(),
        };

        let reading = read_claude_server_addresses(
            &scripted.driver.sign_in_sources_for(None).await,
            vec![address_read(managed, Vec::new())],
            |_| Ok(scripted.driver.sources.base_environment.to_vec()),
        )
        .await
        .pop()
        .expect("one reading answers one request")
        .expect("the organization's entry reads");

        let McpServerAddressReading::Declared(address) = &reading else {
            panic!("the organization's address is declared, not {reading:?}");
        };
        assert_eq!(address.as_str(), "https://docs.example.test/mcp");
    }
}
