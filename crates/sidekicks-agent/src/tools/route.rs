//! The daemon's tool servers as a provider reaches them at an address on the listener: each
//! spawn's entry is added under a secret minted for it, which its configuration carries as an
//! `Authorization` header, so the address itself holds no secret.

use std::sync::Arc;

use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_provider::port::tool_server_route::{
    OpenedToolServerRoute, ToolServerRoute, ToolServerRouteEntry, ToolServerSecretError,
    ToolServerSpawn,
};

use crate::tools::entries::ToolServerEntries;
use crate::tools::server::ToolServerPath;

/// The header a spawn's secret travels in.
const AUTHORIZATION_HEADER: &str = "Authorization";

/// The route to the tool servers on the listener at `127.0.0.1:<port>`, adding each spawn's entry
/// to the table every request is admitted against.
pub struct AgentToolServerRoute {
    /// Every live spawn's entry.
    entries: Arc<ToolServerEntries>,
    /// The listener's port on `127.0.0.1`.
    port: u16,
}

impl AgentToolServerRoute {
    /// The route on the listener at `port`, admitting against `entries`.
    pub fn new(entries: Arc<ToolServerEntries>, port: u16) -> Self {
        Self { entries, port }
    }
}

impl ToolServerRoute for AgentToolServerRoute {
    fn open(
        &self,
        spawn: ToolServerSpawn,
        server_names: &[&str],
    ) -> Result<OpenedToolServerRoute, ToolServerSecretError> {
        let mut entries = Vec::with_capacity(server_names.len());
        let mut guards = Vec::with_capacity(server_names.len());
        for server_name in server_names {
            let path = ToolServerPath {
                session_id: spawn.session_id,
                conversation: spawn.conversation,
                server_name: (*server_name).to_owned(),
            };
            let token = BearerToken::mint().map_err(ToolServerSecretError)?;
            entries.push(ToolServerRouteEntry {
                server_name: (*server_name).to_owned(),
                url: format!("http://127.0.0.1:{}{path}", self.port),
                http_headers: vec![(
                    AUTHORIZATION_HEADER.to_owned(),
                    (*token.header_value()).clone(),
                )],
            });
            guards.push(self.entries.insert(
                path,
                spawn.provider.clone(),
                token,
                Arc::clone(&spawn.dispatcher),
            ));
        }
        Ok(OpenedToolServerRoute::new(entries, Box::new(guards)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::port::tool_server_route::{
        ToolServerConversation, ToolServerRoute, ToolServerSpawn,
    };
    use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;

    use super::AgentToolServerRoute;
    use crate::tools::entries::ToolServerEntries;
    use crate::tools::entries::tests::dispatcher;
    use crate::tools::server::ToolServerPath;

    // A spawn's entry carries its secret only as an `Authorization` header: the address holds no
    // part of it, the header's secret admits the spawn at the path the address names, and the
    // entry leaves once the spawn lets the route go. Killed by the secret in the path, a header
    // the entry does not admit, or a hold that keeps the entry past the spawn.
    #[test]
    fn a_spawns_secret_rides_a_header_the_entry_admits_and_never_the_address() {
        let entries = Arc::new(ToolServerEntries::default());
        let route = AgentToolServerRoute::new(Arc::clone(&entries), 4_100);
        let session_id =
            SessionId::new("0192f3a4-5b6c-7d8e-9f01-23456789abce").expect("the text is a UUID");
        let opened = route
            .open(
                ToolServerSpawn {
                    session_id,
                    conversation: ToolServerConversation::of_session(session_id),
                    provider: ProviderId::new("codex".to_owned()).expect("the id is well formed"),
                    dispatcher: dispatcher(),
                },
                &[DAEMON_TOOL_SERVER_NAME],
            )
            .expect("the system's random source reads");
        let entry = opened
            .entry(DAEMON_TOOL_SERVER_NAME)
            .expect("the spawn opened the daemon's entry");

        let [(name, value)] = entry.http_headers.as_slice() else {
            panic!("the entry carries one header");
        };
        assert_eq!(name, "Authorization");
        let secret = value
            .strip_prefix("Bearer ")
            .expect("the header presents a bearer secret");
        assert_eq!(secret.len(), 64, "the secret is a minted 32-byte hex token");
        assert!(!entry.url.contains(secret), "the address holds no secret");
        let path_text = entry
            .url
            .strip_prefix("http://127.0.0.1:4100")
            .expect("the address is the listener's");
        let path = ToolServerPath::parse(path_text).expect("the address names a tool server");
        assert_eq!(path.session_id, session_id);
        assert!(entries.admitted(&path, Some(value.as_bytes())).is_some());

        let header = value.clone();
        drop(opened);
        assert!(entries.admitted(&path, Some(header.as_bytes())).is_none());
    }
}
