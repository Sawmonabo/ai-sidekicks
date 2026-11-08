//! The whole address a Claude Code server's entry declares, read from the same entry a sign-in
//! through Claude Code copies, its `url` filled as Claude Code fills it before it connects.

use serde_json::Value;
use sidekicks_contracts::mcp::server::config::McpServerAddress;

use super::{ClaudeMcpSignInSources, read_sign_in_entry};
use crate::driver::claude::mcp::config::URL_MEMBER;
use crate::driver::claude::mcp::machine_probe::variables::expand_remote_address;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading, NoPersonServerEntry,
};

/// The text that opens a variable in an entry's `url`, which one left unfilled still holds.
const VARIABLE_OPENING: &str = "${";

/// Reads the whole address `request`'s server entry declares, its `url` filled from
/// `environment`: a server of an administrator's MCP file, whose entry only Claude Code's own
/// process reads, answers [`McpServerAddressReading::ReadByProviderOnly`]. Fails with
/// [`DriverError::NoPersonServerEntry`] for a connector, an organization's server read for no
/// account, and an entry that is gone or names no `url`, and as the entry's read fails.
pub(crate) async fn read_claude_server_address(
    sources: &ClaudeMcpSignInSources<'_>,
    environment: &[(String, String)],
    request: &McpServerAddressRead,
) -> Result<McpServerAddressReading, DriverError> {
    let Some(entry) = read_sign_in_entry(
        sources,
        &request.binding,
        request.provider_account_id.as_ref(),
    )
    .await?
    else {
        return Ok(McpServerAddressReading::ReadByProviderOnly);
    };
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
    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerBindingRef;

    use super::super::tests::{
        PERSON_CONFIG, SERVER_NAME, driver_on_environment, name, user_binding,
    };
    use crate::driver::DriverServices;
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::session::scripted::driver::ScriptedDriver;
    use crate::driver::contract::error::DriverError;
    use crate::driver::contract::sign_in::{McpServerAddressRead, McpServerAddressReading};
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A read of `binding`'s address for the test account, at no project root.
    fn address_read(binding: McpServerBindingRef) -> McpServerAddressRead {
        McpServerAddressRead {
            binding,
            provider_account_id: Some(test_provider_account_id()),
            root_folder: None,
        }
    }

    // A person's entry is read whole, its user name and query kept, and its `url` filled from the
    // driver's base environment as Claude Code fills it: a default where the variable is unset,
    // the value where it is set, and a variable with no value and no default left unreadable.
    // Killed by answering the stripped address (the user name or query lost), by removing the
    // expansion (`expand_remote_address(url, environment)` replaced with `url.to_owned()` fails the
    // default case), and by answering a text that is not an address as `Declared`.
    #[rstest]
    #[case::user_name_and_query_kept(
        &[],
        "https://user@docs.example.test/mcp?key=k",
        Some("https://user@docs.example.test/mcp?key=k")
    )]
    #[case::a_default_where_unset(
        &[],
        "${API_BASE_URL:-https://docs.example.test}/mcp",
        Some("https://docs.example.test/mcp")
    )]
    #[case::the_value_where_set(
        &[("API_BASE_URL", "https://other.example.test")],
        "${API_BASE_URL:-https://docs.example.test}/mcp",
        Some("https://other.example.test/mcp")
    )]
    #[case::a_variable_with_no_value(&[], "https://${TENANT}.example.test/mcp", None)]
    #[tokio::test]
    async fn a_claude_entry_is_read_whole_with_its_variables_filled(
        #[case] variables: &[(&str, &str)],
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
            .read_mcp_server_address(address_read(user_binding()))
            .await
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
            .read_mcp_server_address(address_read(connector.clone()))
            .await;

        assert!(
            matches!(
                &refused,
                Err(DriverError::NoPersonServerEntry(no_entry)) if no_entry.binding == connector
            ),
            "a connector reads the no-entry arm, not {refused:?}"
        );
    }
}
