//! What one of a session's servers offers to attach, read by the daemon itself where its provider
//! lists it to no one: one connection made for the read alone, a second copy of a program server
//! or a connection to a server at an address, `resources/list` read page by page over it, then
//! closed. A program server runs one copy at a time per binding.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use reqwest::header::{HeaderName, HeaderValue};
use rmcp::service::ServiceError;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::session::controls::methods::SessionMcpResource;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{PathRules, Spawner};
use sidekicks_provider::driver::ProviderDescriptor;
use sidekicks_provider::driver::mcp_server::resources::{McpServerReach, read_listed_mcp_resource};
use sidekicks_provider::spawn_environment::{
    ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
};

use crate::binding::store::McpBindingKey;
use crate::client::McpClient;
use crate::client::connection::McpServerConnection;
use crate::client::http::NoAuthorization;
use crate::client::stdio::McpStdioServer;

/// What a server offers to attach.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerResources {
    /// Its resources, each as the attachment list shows it.
    pub resources: Vec<SessionMcpResource>,
    /// Whether every page was read; `false` where the page cap stopped the read.
    pub complete: bool,
}

/// What a second copy of a program server starts from: the thread every child starts on, and the
/// provider and reserved names its environment is built under.
pub struct McpServerCopyStart<'a> {
    /// The thread every child of the daemon starts on.
    pub spawner: &'a Spawner,
    /// The session's provider, whose withheld names the copy's environment leaves out.
    pub descriptor: &'a ProviderDescriptor,
    /// The names no person's row may set, with every provider's background-work switches.
    pub reserved_names: &'a ReservedEnvironmentNames,
}

/// Why a server's resources could not be read.
#[derive(Debug, thiserror::Error)]
pub enum McpResourceListError {
    /// The copy did not start, or the connection did not open.
    #[error("the tool server could not be reached")]
    Reach(#[source] Box<dyn Error + Send + Sync>),
    /// A page's request failed.
    #[error("the tool server's resources could not be read")]
    List(#[source] ServiceError),
}

impl McpClient {
    /// The resources of `binding`'s server, one of `session_id`'s, reached as `reach` says: a
    /// program started as a copy from `copy_start`, one at a time per binding, or the server at
    /// its address with no sign-in; the connection is closed, and a copy ended, before this
    /// answers. Fails as [`McpResourceListError`] says.
    pub async fn list_server_resources(
        &self,
        session_id: SessionId,
        binding: &McpServerBindingRef,
        reach: McpServerReach,
        copy_start: McpServerCopyStart<'_>,
    ) -> Result<McpServerResources, McpResourceListError> {
        let scope = self.connection_scope(session_id, binding.server_name().clone());
        let connection = match reach {
            McpServerReach::Stdio {
                program,
                arguments,
                environment,
                working_folder,
            } => {
                let _copy = self
                    .resource_copies
                    .acquire(McpBindingKey::of(binding))
                    .await;
                let request = ProviderEnvironmentRequest {
                    session: SessionEnvironment {
                        base: &environment,
                        every_project_rows: &[],
                        project_rows: &[],
                        reserved_names: copy_start.reserved_names,
                        rules: PathRules::NATIVE,
                    },
                    descriptor: copy_start.descriptor,
                    deny_env_vars: &[],
                    credential_homes: &[],
                };
                let server = McpStdioServer {
                    program: PathBuf::from(program),
                    arguments,
                    environment: Vec::new(),
                    working_folder,
                    startup_timeout: None,
                };
                let connection =
                    McpServerConnection::start_stdio(copy_start.spawner, server, &request, scope)
                        .await
                        .map_err(|error| McpResourceListError::Reach(Box::new(error)))?;
                return list_and_close(&connection).await;
            }
            McpServerReach::Address { address, headers } => {
                let headers = read_headers(headers)?;
                McpServerConnection::connect_http(
                    &address,
                    headers,
                    Arc::new(NoAuthorization),
                    None,
                    scope,
                )
                .await
                .map_err(|error| McpResourceListError::Reach(Box::new(error)))?
            }
        };
        list_and_close(&connection).await
    }
}

// Reads every page of `connection`'s resources, then closes it, a copy's process ended with it,
// whether the read passed or failed.
async fn list_and_close(
    connection: &McpServerConnection,
) -> Result<McpServerResources, McpResourceListError> {
    let listed = connection.requests.list_all_resources().await;
    connection.close().await;
    let (resources, complete) = listed.map_err(McpResourceListError::List)?;
    Ok(McpServerResources {
        resources: resources
            .iter()
            .filter_map(|resource| {
                read_listed_mcp_resource(
                    serde_json::to_value(resource).expect("an MCP resource is JSON data"),
                )
            })
            .collect(),
        complete,
    })
}

// The entry's headers as each request carries them; one whose name or value no request can carry
// fails the reach.
fn read_headers(
    headers: Vec<(String, String)>,
) -> Result<HashMap<HeaderName, HeaderValue>, McpResourceListError> {
    headers
        .into_iter()
        .map(|(name, value)| {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| McpResourceListError::Reach(Box::new(error)))?;
            let value = HeaderValue::from_str(&value)
                .map_err(|error| McpResourceListError::Reach(Box::new(error)))?;
            Ok((name, value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use futures::FutureExt as _;
    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::list_and_close;
    use crate::client::connection::McpConnectionStart;
    use crate::client::test_server::{
        Reply, method_not_found, start_test_server, test_client, v1_initialize_result,
    };
    use crate::client::tests::lasting_process;

    // Mutations: in `list_and_close`, leave out the close, and the copy's process is still
    // running when the read answers; in `list_every_page`, read only the first page, and the
    // second page's resource is missing.
    #[tokio::test(start_paused = true)]
    async fn a_copy_lists_every_page_and_has_ended_when_the_read_answers() {
        let (client, _card) = test_client();
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let name: McpServerName =
            FreeFormText::new("tracker".to_owned()).expect("a short server name");
        let process = lasting_process(&client, session_id, &name).await;
        let (opened, _server) = start_test_server(
            client.connection_scope(session_id, name),
            Box::new(|method, params| match method {
                "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                "resources/list" if params.get("cursor").is_none() => {
                    Reply::Answer(json!({ "result": {
                        "resources": [{ "uri": "tracker://one", "name": "one" }],
                        "nextCursor": "page-2",
                    }}))
                }
                "resources/list" => Reply::Answer(json!({ "result": {
                    "resources": [{ "uri": "tracker://two", "name": "two", "size": 12 }],
                }})),
                _ => method_not_found(),
            }),
            McpConnectionStart::stdio(None, Some(process)),
        )
        .await;
        let connection = opened.expect("the test server completes its start");

        let listed = list_and_close(&connection)
            .await
            .expect("the resources read");

        let names: Vec<&str> = listed
            .resources
            .iter()
            .map(|resource| resource.name.as_str())
            .collect();
        assert_eq!(names, ["one", "two"], "both pages' resources are kept");
        assert!(listed.complete, "the list ended before the page cap");
        let process = connection
            .process
            .as_ref()
            .expect("the copy holds its process");
        assert!(
            process.end().now_or_never().is_some(),
            "the copy's process has ended"
        );
    }
}
