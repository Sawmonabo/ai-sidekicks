//! The `/` list's tool-server prompts: each working server's prompts for a session, read with
//! `prompts/list` over the connections the client already holds, every server at once so a slow
//! one delays no other, and the listeners told when a server says its prompts changed (rmcp drops
//! its own cached list on that notification too).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rmcp::model::Prompt;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandEntry,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::client::McpClient;
use sidekicks_provider::port::server_prompts::ServerPromptPort;
use sidekicks_std::mutex_lock::lock;

/// A listener of one session's prompts.
type PromptListener = Arc<dyn Fn() + Send + Sync>;

/// The listeners of each session's tool-server prompts, by session and their own number.
#[derive(Default)]
pub(crate) struct PromptWatchers {
    listeners: Mutex<HashMap<SessionId, Vec<(u64, PromptListener)>>>,
    next_listener: AtomicU64,
}

impl PromptWatchers {
    /// Tells every listener of `session_id` that a server's prompts changed.
    pub(super) fn notify(&self, session_id: SessionId) {
        let listeners: Vec<PromptListener> = lock(&self.listeners)
            .get(&session_id)
            .map(|listeners| {
                listeners
                    .iter()
                    .map(|(_, listener)| Arc::clone(listener))
                    .collect()
            })
            .unwrap_or_default();
        for listener in listeners {
            listener();
        }
    }

    fn add(self: &Arc<Self>, session_id: SessionId, on_change: PromptListener) -> u64 {
        let number = self.next_listener.fetch_add(1, Ordering::Relaxed);
        lock(&self.listeners)
            .entry(session_id)
            .or_default()
            .push((number, on_change));
        number
    }

    fn remove(&self, session_id: SessionId, number: u64) {
        let mut listeners = lock(&self.listeners);
        if let Some(session) = listeners.get_mut(&session_id) {
            session.retain(|(kept, _)| *kept != number);
            if session.is_empty() {
                listeners.remove(&session_id);
            }
        }
    }
}

impl ServerPromptPort for McpClient {
    fn read_prompts(
        &self,
        session_id: SessionId,
        binding: ProviderCommandBinding,
    ) -> BoxFuture<'_, Vec<ProviderCommandEntry>> {
        async move {
            let connections = self.session_connections(session_id);
            let read = futures::future::join_all(
                connections
                    .iter()
                    .map(|connection| connection.requests.list_all_prompts()),
            )
            .await;
            let mut entries = Vec::new();
            for (connection, prompts) in connections.iter().zip(read) {
                let server = &connection.scope.server_name;
                match prompts {
                    Ok(prompts) => entries.extend(
                        prompts
                            .into_iter()
                            .filter_map(|prompt| prompt_entry(prompt, server, &binding)),
                    ),
                    // The list carries only prompts that exist; the server's failure shows on
                    // its own row, not here.
                    Err(error) => tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        server = server.as_str(),
                        "a tool server's prompts could not be read"
                    ),
                }
            }
            entries
        }
        .boxed()
    }

    fn watch_prompts(
        &self,
        session_id: SessionId,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Box<dyn FnOnce() + Send> {
        let watchers = Arc::clone(&self.prompt_watchers);
        let number = watchers.add(session_id, on_change);
        Box::new(move || watchers.remove(session_id, number))
    }
}

/// One prompt as a `/` list entry naming its server, its arguments' names as the hint; `None`
/// for a prompt whose name or words break the entry's bounds, which the list leaves out.
fn prompt_entry(
    prompt: Prompt,
    server: &McpServerName,
    binding: &ProviderCommandBinding,
) -> Option<ProviderCommandEntry> {
    let argument_hint = prompt
        .arguments
        .filter(|arguments| !arguments.is_empty())
        .map(|arguments| {
            arguments
                .iter()
                .map(|argument| argument.name.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .and_then(|hint| FreeFormText::new(hint).ok());
    Some(ProviderCommandEntry::Prompt {
        name: FreeFormText::new(prompt.name).ok()?,
        description: prompt
            .description
            .and_then(|description| FreeFormText::new(description).ok()),
        argument_hint,
        scope: None,
        enabled: None,
        binding: binding.clone(),
        server: server.clone(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use tokio::sync::mpsc;

    use crate::client::test_server::{
        Reply, method_not_found, open_test_server, test_client, v1_initialize_result,
    };
    use sidekicks_provider::port::server_prompts::ServerPromptPort as _;

    // Mutation: in `connection.rs`, empty `on_prompt_list_changed`, or notify another session
    // there; or in `PromptWatchers::notify`, skip the listeners.
    #[tokio::test]
    async fn a_prompt_list_change_reaches_only_its_sessions_listeners() {
        let (client, _card) = test_client();
        let (_connection, server) = open_test_server(
            &client,
            Box::new(|method, _params| match method {
                "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                "tools/list" => Reply::Answer(json!({ "result": { "tools": [] } })),
                _ => method_not_found(),
            }),
        )
        .await;
        let (changed, mut changes) = mpsc::unbounded_channel();
        let own = changed.clone();
        let _own_watch = client.watch_prompts(
            server.session_id,
            Arc::new(move || own.send("own").expect("the test is listening")),
        );
        let other_session =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let _other_watch = client.watch_prompts(
            other_session,
            Arc::new(move || changed.send("other").expect("the test is listening")),
        );

        server
            .unasked
            .send(
                json!({ "jsonrpc": "2.0", "method": "notifications/prompts/list_changed" })
                    .to_string(),
            )
            .expect("the server is running");

        let change = tokio::time::timeout(Duration::from_secs(1), changes.recv())
            .await
            .expect("the change arrives");
        assert_eq!(change, Some("own"));
        assert!(changes.try_recv().is_err());
    }
}
