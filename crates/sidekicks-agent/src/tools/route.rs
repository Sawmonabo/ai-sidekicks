//! The daemon's tool servers as a provider reaches them at an address on the listener: each
//! spawn's entry is added under a secret the daemon's key derives for its address, which its
//! configuration carries as an `Authorization` header, so the address itself holds no secret and
//! a later start of the daemon makes the same secret again.

use std::sync::Arc;

use sidekicks_provider::port::tool_server_route::{
    OpenedToolServerRoute, ToolServerRoute, ToolServerRouteEntry, ToolServerSpawn,
};

use crate::tools::entries::{ToolServerEntries, ToolServerEntryGuard};
use crate::tools::secret_key::ToolServerSecretKey;
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
    /// The key every entry's secret is derived from.
    key: Arc<ToolServerSecretKey>,
}

impl AgentToolServerRoute {
    /// The route on the listener at `port`, admitting against `entries`, its secrets derived from
    /// `key`.
    pub fn new(entries: Arc<ToolServerEntries>, port: u16, key: Arc<ToolServerSecretKey>) -> Self {
        Self { entries, port, key }
    }

    // Adds `spawn`'s entry on each of `server_names`. Answers the entries, their paths and the
    // guards that keep them admitted.
    fn open_entries(
        &self,
        spawn: &ToolServerSpawn,
        server_names: &[&str],
    ) -> (
        Vec<ToolServerRouteEntry>,
        Vec<ToolServerPath>,
        Vec<ToolServerEntryGuard>,
    ) {
        let mut entries = Vec::with_capacity(server_names.len());
        let mut paths = Vec::with_capacity(server_names.len());
        let mut guards = Vec::with_capacity(server_names.len());
        for server_name in server_names {
            let path = ToolServerPath {
                session_id: spawn.session_id,
                conversation: spawn.conversation,
                server_name: (*server_name).to_owned(),
            };
            let token = self.key.secret_of(&path);
            entries.push(ToolServerRouteEntry {
                server_name: (*server_name).to_owned(),
                url: format!("http://127.0.0.1:{}{path}", self.port),
                http_headers: vec![(
                    AUTHORIZATION_HEADER.to_owned(),
                    (*token.header_value()).clone(),
                )],
            });
            guards.push(self.entries.insert(
                path.clone(),
                spawn.provider.clone(),
                token,
                Arc::clone(&spawn.dispatcher),
                spawn.hook_tools.clone(),
            ));
            paths.push(path);
        }
        (entries, paths, guards)
    }
}

impl ToolServerRoute for AgentToolServerRoute {
    fn open(&self, spawn: ToolServerSpawn, server_names: &[&str]) -> OpenedToolServerRoute {
        let (entries, _, guards) = self.open_entries(&spawn, server_names);
        OpenedToolServerRoute::new(entries, Box::new(guards))
    }

    fn adopt(&self, spawn: ToolServerSpawn, server_names: &[&str]) -> OpenedToolServerRoute {
        let (entries, paths, guards) = self.open_entries(&spawn, server_names);
        let adoptions: Vec<_> = paths
            .iter()
            .filter_map(|path| self.entries.adopt(path, Arc::clone(&self.key)))
            .collect();
        // The adoptions go first, so none answers through an entry already let go.
        OpenedToolServerRoute::new(entries, Box::new((adoptions, guards)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use reqwest::StatusCode;
    use reqwest::header::WWW_AUTHENTICATE;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::bearer_token::BearerToken;
    use sidekicks_provider::port::tool_server_route::{
        OpenedToolServerRoute, ToolServerConversation, ToolServerRoute, ToolServerSpawn,
    };
    use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
    use sidekicks_store::credential_store::SecretKeychain;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::credential_store::test_keychain::test_keychain;

    use super::AgentToolServerRoute;
    use crate::tools::entries::ToolServerEntries;
    use crate::tools::entries::tests::dispatcher;
    use crate::tools::listener::tests::{CODEX_SESSION, Served, initialize, ping, serve_stub};
    use crate::tools::secret_key::ToolServerSecretKey;
    use crate::tools::server::ToolServerPath;

    const REVISION: &str = "2025-11-25";

    /// A Codex spawn of `session_id` under a key of its own.
    fn codex_spawn(session_id: SessionId) -> ToolServerSpawn {
        ToolServerSpawn {
            session_id,
            conversation: ToolServerConversation::mint(),
            provider: ProviderId::new("codex".to_owned()).expect("the id is well formed"),
            dispatcher: dispatcher(),
            hook_tools: None,
        }
    }

    /// The path and the secret of the daemon's entry `opened` carries.
    fn path_and_secret(opened: &OpenedToolServerRoute) -> (String, String) {
        let entry = opened
            .entry(DAEMON_TOOL_SERVER_NAME)
            .expect("the spawn opened the daemon's entry");
        let path = entry
            .url
            .strip_prefix("http://127.0.0.1:4100")
            .expect("the address is the listener's")
            .to_owned();
        let [(_, value)] = entry.http_headers.as_slice() else {
            panic!("the entry carries one header");
        };
        let secret = value
            .strip_prefix("Bearer ")
            .expect("the header presents a bearer secret");
        (path, secret.to_owned())
    }

    /// The route over `served`'s entries, its secrets derived from the key `keychain` keeps.
    async fn route_over(served: &Served, keychain: &dyn SecretKeychain) -> AgentToolServerRoute {
        let key = ToolServerSecretKey::read_or_create(keychain)
            .await
            .expect("the test keychain keeps the key");
        AgentToolServerRoute::new(Arc::clone(&served.entries), 4_100, Arc::new(key))
    }

    // Across a restart, a conversation Codex kept running under the earlier start's address and
    // secret is admitted by the spawn that adopts it: the key read back from the keychain derives
    // the same secret, the session it kept is unknown and answered 404 so it opens a new one, and
    // the new one is served; once the adoption is let go the address answers nothing. Killed by a
    // secret minted at random, a key made again at each start, an adoption that answers nothing or
    // never leaves, and a kept session refused instead of answered 404.
    #[tokio::test]
    async fn an_adopted_conversation_is_admitted_under_its_rebuilt_secret() {
        let (_data_folder, _platform_store, keychain) =
            test_keychain(KeychainService::ToolServerKey);
        let session_id = SessionId::new(CODEX_SESSION).expect("the text is a UUID");

        let earlier = serve_stub().await;
        let kept = route_over(&earlier, keychain.as_ref())
            .await
            .open(codex_spawn(session_id), &[DAEMON_TOOL_SERVER_NAME]);
        let (path, secret) = path_and_secret(&kept);
        let kept_session = earlier.open_session(&path, &secret, REVISION).await;
        drop((kept, earlier));

        let later = serve_stub().await;
        let adopted = route_over(&later, keychain.as_ref())
            .await
            .adopt(codex_spawn(session_id), &[DAEMON_TOOL_SERVER_NAME]);
        let stale = ping(&later, &path, &kept_session, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(stale.status(), StatusCode::NOT_FOUND);
        let new_session = later.open_session(&path, &secret, REVISION).await;
        let answered = ping(&later, &path, &new_session, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(answered.status(), StatusCode::OK);

        drop(adopted);
        let let_go = initialize(&later, &path, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(let_go.status(), StatusCode::UNAUTHORIZED);
    }

    // While a spawn adopts its session's earlier conversations, a request at another conversation's
    // address of the session is admitted only with the secret this daemon's key derives for that
    // address: a secret no key derived, or one another key derived for the same address, is 401
    // with no `WWW-Authenticate`. Killed by an adoption that admits any secret, an unkeyed hash,
    // and a refusal that names a challenge.
    #[tokio::test]
    async fn a_secret_this_daemon_never_issued_is_refused_beside_an_adoption() {
        let key = ToolServerSecretKey::of_bytes(1);
        let served = serve_stub().await;
        let route = AgentToolServerRoute::new(Arc::clone(&served.entries), 4_100, Arc::new(key));
        let session_id = SessionId::new(CODEX_SESSION).expect("the text is a UUID");
        let _adopted = route.adopt(codex_spawn(session_id), &[DAEMON_TOOL_SERVER_NAME]);
        let earlier = ToolServerPath {
            session_id,
            conversation: ToolServerConversation::mint(),
            server_name: DAEMON_TOOL_SERVER_NAME.to_owned(),
        };
        let path = earlier.to_string();

        let issued = ToolServerSecretKey::of_bytes(1).secret_of(&earlier);
        let admitted = initialize(&served, &path, REVISION)
            .bearer_auth(issued.text())
            .send()
            .await
            .expect("an answer");
        assert_eq!(admitted.status(), StatusCode::OK);

        let minted = BearerToken::mint().expect("the system's random source reads");
        let other_key = ToolServerSecretKey::of_bytes(7).secret_of(&earlier);
        for (row, foreign) in [
            ("a secret no key derived", minted.text()),
            ("another key's secret", other_key.text()),
        ] {
            let refused = initialize(&served, &path, REVISION)
                .bearer_auth(foreign)
                .send()
                .await
                .expect("an answer");
            assert_eq!(refused.status(), StatusCode::UNAUTHORIZED, "{row}");
            assert!(!refused.headers().contains_key(WWW_AUTHENTICATE), "{row}");
        }
    }

    // A spawn's entry carries its secret only as an `Authorization` header: the address holds no
    // part of it, the header's secret admits the spawn at the path the address names, and the
    // entry leaves once the spawn lets the route go. Killed by the secret in the path, a header
    // the entry does not admit, or a hold that keeps the entry past the spawn.
    #[test]
    fn a_spawns_secret_rides_a_header_the_entry_admits_and_never_the_address() {
        let entries = Arc::new(ToolServerEntries::default());
        let route = AgentToolServerRoute::new(
            Arc::clone(&entries),
            4_100,
            Arc::new(ToolServerSecretKey::of_bytes(1)),
        );
        let session_id =
            SessionId::new("0192f3a4-5b6c-7d8e-9f01-23456789abce").expect("the text is a UUID");
        let opened = route.open(
            ToolServerSpawn {
                session_id,
                conversation: ToolServerConversation::of_session(session_id),
                provider: ProviderId::new("codex".to_owned()).expect("the id is well formed"),
                dispatcher: dispatcher(),
                hook_tools: None,
            },
            &[DAEMON_TOOL_SERVER_NAME],
        );
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
        assert_eq!(
            secret.len(),
            64,
            "the secret is a derived 32-byte hex token"
        );
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
