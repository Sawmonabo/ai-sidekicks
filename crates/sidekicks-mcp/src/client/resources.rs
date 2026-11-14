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
use sidekicks_platforms::Spawner;
use sidekicks_provider::driver::mcp_server::resources::{McpServerReach, read_listed_mcp_resource};

use crate::binding::store::McpBindingKey;
use crate::client::McpClient;
use crate::client::connection::McpServerConnection;
use crate::client::http::NoAuthorization;
use crate::client::stdio::{McpServerBaseEnvironment, McpStdioServer};
use crate::sign_in::credential_store::SignInCustody;

/// What a server offers to attach.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerResources {
    /// Its resources, each as the attachment list shows it.
    pub resources: Vec<SessionMcpResource>,
    /// Whether every page was read; `false` where the page cap stopped the read.
    pub complete: bool,
}

/// Why a server's resources could not be read.
#[derive(Debug, thiserror::Error)]
pub enum McpResourceListError {
    /// The copy did not start, the address key a connection's endpoint is keyed with could not
    /// be read, or the connection did not open.
    #[error("the tool server could not be reached")]
    Reach(#[source] Box<dyn Error + Send + Sync>),
    /// A page's request failed.
    #[error("the tool server's resources could not be read")]
    List(#[source] ServiceError),
}

impl McpClient {
    /// The resources of `binding`'s server, one of `session_id`'s, reached as `reach` says: a
    /// program started on `spawner` as a copy in its provider process's environment, one at a time
    /// per binding, or the server at its address with no sign-in, its endpoint the digest
    /// `sign_ins` keeps the address's sign-in under; the connection is closed, and a copy ended,
    /// before this answers. Fails as [`McpResourceListError`] says.
    pub async fn list_server_resources(
        &self,
        session_id: SessionId,
        binding: &McpServerBindingRef,
        reach: McpServerReach,
        spawner: &Spawner,
        sign_ins: &SignInCustody,
    ) -> Result<McpServerResources, McpResourceListError> {
        let scope = self.connection_scope(session_id, binding.server_name().clone());
        let connection = match reach {
            McpServerReach::Stdio {
                program,
                arguments,
                process_environment,
                server_environment,
                working_folder,
            } => {
                let _copy = self
                    .resource_copies
                    .acquire(McpBindingKey::of(binding))
                    .await;
                let server = McpStdioServer {
                    program: PathBuf::from(program),
                    arguments,
                    environment: server_environment,
                    working_folder,
                    startup_timeout: None,
                };
                let connection = McpServerConnection::start_stdio(
                    spawner,
                    server,
                    McpServerBaseEnvironment::ProviderProcess(&process_environment),
                    scope,
                )
                .await
                .map_err(|error| McpResourceListError::Reach(Box::new(error)))?;
                return list_and_close(&connection).await;
            }
            McpServerReach::Address { address, headers } => {
                let headers = read_headers(headers)?;
                let digest = sign_ins
                    .digest(&address)
                    .await
                    .map_err(|error| McpResourceListError::Reach(Box::new(error)))?;
                McpServerConnection::connect_http(
                    &address,
                    &digest,
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
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_platforms::{POSIX_SHELL, Spawner};
    use sidekicks_provider::driver::mcp_server::resources::McpServerReach;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::credential_store::test_keychain::test_keychain;

    use super::list_and_close;
    use crate::client::connection::McpConnectionStart;
    use crate::client::test_server::{
        Reply, method_not_found, start_test_server, test_client, v1_initialize_result,
    };
    use crate::client::tests::lasting_process;
    use crate::sign_in::credential_store::SignInCustody;

    /// A program server that writes `start` to the log its first argument names when it starts
    /// and `end` once it answers its resource list, after a 0.2 s pause another copy could start
    /// in; it lists no tools, and any other request is answered as a method it does not have.
    const LOGGING_SERVER: &str = r#"echo start >> "$1"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
  case $line in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":"\
"\"2025-11-25\",\"capabilities\":{\"resources\":{}},"\
"\"serverInfo\":{\"name\":\"tracker\",\"version\":\"1.0.0\"}}}" ;;
    *'"method":"tools/list"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"tools\":[]}}" ;;
    *'"method":"resources/list"'*)
      sleep 0.2
      echo end >> "$1"
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"resources\":[]}}" ;;
    *'"id":'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"error\":{\"code\":-32601,"\
"\"message\":\"Method not found\"}}" ;;
  esac
done"#;

    // Mutation: in `list_server_resources`, take no copy lock, and the second copy starts while
    // the first still runs, so the log reads two starts before any end.
    #[tokio::test]
    async fn two_lists_of_one_binding_run_one_copy_at_a_time() {
        let (client, _card) = test_client();
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let binding = McpServerBindingRef::User {
            provider: ProviderId::new("provider-a".to_owned()).expect("a provider id"),
            server_name: FreeFormText::new("tracker".to_owned()).expect("a short server name"),
        };
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let log = folder.path().join("copies.log");
        let reach = || McpServerReach::Stdio {
            program: POSIX_SHELL.to_owned(),
            arguments: vec![
                "-c".to_owned(),
                LOGGING_SERVER.to_owned(),
                "sh".to_owned(),
                log.to_string_lossy().into_owned(),
            ],
            process_environment: vec![(
                "PATH".to_owned(),
                std::env::var("PATH").expect("the test runs with a PATH"),
            )],
            server_environment: Vec::new(),
            working_folder: None,
        };

        let (_data_folder, _credentials, keychain) = test_keychain(KeychainService::McpSignIns);
        let sign_ins = SignInCustody::new(keychain);

        let (first, second) = tokio::join!(
            client.list_server_resources(session_id, &binding, reach(), &spawner, &sign_ins),
            client.list_server_resources(session_id, &binding, reach(), &spawner, &sign_ins),
        );

        first.expect("the first copy lists");
        second.expect("the second copy lists");
        let logged = std::fs::read_to_string(&log).expect("the copies wrote the log");
        assert_eq!(logged, "start\nend\nstart\nend\n");
    }

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
                "tools/list" => Reply::Answer(json!({ "result": { "tools": [] } })),
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
