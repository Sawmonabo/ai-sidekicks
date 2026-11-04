//! The read each Codex start, resume and fork that carries a tool-server table makes first: one
//! `config/read` of the conversation's folder on the session's own service, whose servers the
//! call's table switches by name, and the whole entry of each server the session switches on that
//! the read does not load, read from the person's own Codex folder. A call Codex refuses over a
//! server that changed since the read is sent once more on a fresh read that loads other servers.

use std::future::Future;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use crate::driver::codex::config_read::read_codex_config;
use crate::driver::codex::mcp::observe_codex_mcp_server;
use crate::driver::codex::mcp::session_table::{
    CodexLoadedServers, CodexSessionTableInput, codex_unloaded_bindings,
    compose_codex_session_table,
};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::CodexThreadSettings;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::mcp_server::write::{McpServerEntry, McpServerObservedEntry};
use crate::port::tool_server_route::ToolServerRoute;

/// How Codex's refusal of a call whose configuration it could not load begins.
const CODEX_CONFIGURATION_LOAD_FAILURE: &str = "failed to load configuration:";

/// Codex's refusal of a server entry holding a member its transport does not take, for each of
/// its two transports.
const CODEX_TRANSPORT_MEMBER_REFUSALS: [&str; 2] = [
    "is not supported for stdio",
    "is not supported for streamable_http",
];

/// The servers Codex loads for `worktree`, the conversation's folder, read on `connection`, the
/// session's own service. Fails as the read fails.
pub(crate) async fn read_codex_loaded_servers(
    connection: &CodexAppServerConnection,
    worktree: &Path,
) -> Result<CodexLoadedServers, CodexError> {
    let read = read_codex_config::<Value>(connection, worktree, false).await?;
    Ok(CodexLoadedServers::of_config(read.config))
}

/// The `mcp_servers` table one start, resume or fork of `settings`' session carries over
/// `loaded`, the call's own read, with the daemon's server on `route`: the whole entry of each
/// server the session switches on that the read does not load is read through `services` from the
/// person's own Codex folder, at the binding's root, one read per server and none when the read
/// loads them all. Fails as the folder's service cannot be started or a read fails.
pub(crate) async fn compose_codex_call_table(
    services: &CodexServiceRegistry,
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
    loaded: &CodexLoadedServers,
) -> Result<Map<String, Value>, CodexError> {
    let worktree = settings.working_directory.as_path();
    let unloaded: Vec<&McpServerBindingRef> =
        codex_unloaded_bindings(&settings.tool_servers, loaded, worktree).collect();
    let unloaded_entries = if unloaded.is_empty() {
        Vec::new()
    } else {
        services
            .read_on_personal_folder(PersonalFolderRead::Config, |service| async move {
                let connection = service.connection()?;
                let mut entries = Vec::with_capacity(unloaded.len());
                for binding in unloaded {
                    let folder = binding_folder(binding, worktree);
                    let observed = observe_codex_mcp_server(&connection, binding, &folder).await?;
                    // A binding whose folder declares no transport for it has nothing to send.
                    if let McpServerObservedEntry::Present(entry) = observed.entry {
                        entries.push((binding.clone(), entry));
                    }
                }
                Ok::<Vec<(McpServerBindingRef, McpServerEntry)>, CodexError>(entries)
            })
            .await?
    };
    Ok(compose_codex_session_table(CodexSessionTableInput {
        session_id: settings.session_id,
        tool_servers: &settings.tool_servers,
        loaded,
        unloaded_entries: &unloaded_entries,
        route,
        worktree_root: worktree,
        is_copy_fork: false,
    }))
}

/// Reads what Codex loads for `worktree` on `connection`, then runs `compose_and_send`, which
/// composes the call's table and params over that read and sends the call. Where Codex refuses
/// the call, with no `data`, because it could not load the configuration or a server's entry
/// holds a member its transport does not take, the servers are read again, and the call is sent
/// once more over the new read when it loads other names, its answer final; an unchanged read
/// returns the refusal. Fails as either read fails, and as the call does.
pub(crate) async fn send_with_stale_name_resend<Reply, Sending>(
    connection: &CodexAppServerConnection,
    worktree: &Path,
    mut compose_and_send: impl FnMut(CodexLoadedServers) -> Sending,
) -> Result<Reply, CodexError>
where
    Sending: Future<Output = Result<Reply, CodexError>>,
{
    let loaded = read_codex_loaded_servers(connection, worktree).await?;
    let refusal = match compose_and_send(loaded.clone()).await {
        Err(refusal) if is_stale_configuration_refusal(&refusal) => refusal,
        sent => return sent,
    };
    let reread = read_codex_loaded_servers(connection, worktree).await?;
    if reread.has_same_names(&loaded) {
        return Err(refusal);
    }
    compose_and_send(reread).await
}

// Whether `error` is Codex's refusal of a configuration that no longer loads as read: no `data`,
// which a cloud bundle's failure always carries, and a load failure or a transport's refusal of a
// member.
fn is_stale_configuration_refusal(error: &CodexError) -> bool {
    matches!(
        error,
        CodexError::ProviderRequest { data: None, message, .. }
            if message.starts_with(CODEX_CONFIGURATION_LOAD_FAILURE)
                || CODEX_TRANSPORT_MEMBER_REFUSALS
                    .iter()
                    .any(|refusal| message.contains(refusal))
    )
}

// The folder `binding`'s entry is read at: its root for a `project` or `local` binding, whose
// layer Codex lists only there, and `worktree` for any other, whose layer is the same anywhere.
fn binding_folder(binding: &McpServerBindingRef, worktree: &Path) -> PathBuf {
    match binding {
        McpServerBindingRef::Project { scope_ref, .. }
        | McpServerBindingRef::Local { scope_ref, .. } => PathBuf::from(scope_ref.as_str()),
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => worktree.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_contracts::session::id::SessionId;

    use super::send_with_stale_name_resend;
    use crate::driver::codex::mcp::session_table::{
        CodexLoadedServers, CodexSessionTableInput, compose_codex_session_table,
    };
    use crate::driver::codex::permission_level::CodexProfileFolders;
    use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
    use crate::driver::codex::session::errors::CodexError;
    use crate::driver::codex::thread::settings::{
        CodexThreadSettings, compose_codex_thread_resume_params, compose_codex_thread_start_params,
    };
    use crate::driver::codex::transport::connection::scripted_service::{
        ScriptedService, connect_scripted_service,
    };
    use crate::driver::codex::transport::connection::{
        CodexAppServerConnection, CodexConnectionHandlers,
    };

    /// The largest message the scripted connection takes, far above any a test sends.
    const MESSAGE_LIMIT: usize = 1 << 20;

    /// The folder the test conversation runs in.
    const WORKTREE: &str = "/work/app";

    fn scripted_connection() -> (CodexAppServerConnection, ScriptedService) {
        let (events, _frames) = CodexDetachedFrames::new();
        connect_scripted_service(
            MESSAGE_LIMIT,
            CodexConnectionHandlers {
                events,
                responder: None,
                token_refresher: None,
            },
        )
    }

    fn settings() -> CodexThreadSettings {
        CodexThreadSettings {
            session_id: SessionId::new("0192f3a4-5b6c-7d8e-9f01-23456789abcd")
                .expect("the text is a UUID"),
            working_directory: PathBuf::from(WORKTREE),
            model: "gpt-5".to_owned(),
            model_context_window: None,
            level: PermissionLevel::Ask,
            profile_folders: CodexProfileFolders {
                working_directory: PathBuf::from(WORKTREE),
                git_common_folder: None,
                deny_paths: Vec::new(),
                command_channel_folder: PathBuf::from("/data/command-channels/session"),
            },
            command_environment: Vec::new(),
            subagent_policy: None,
            helper_roles: Vec::new(),
            tool_servers: Vec::new(),
            base_instructions: None,
        }
    }

    // The table of a session with no servers of its own and no route over `loaded`.
    fn table_over(
        settings: &CodexThreadSettings,
        loaded: &CodexLoadedServers,
    ) -> Map<String, Value> {
        compose_codex_session_table(CodexSessionTableInput {
            session_id: settings.session_id,
            tool_servers: &settings.tool_servers,
            loaded,
            unloaded_entries: &[],
            route: None,
            worktree_root: &settings.working_directory,
            is_copy_fork: false,
        })
    }

    // Answers the `config/read` the connection sent next with `servers` as the loaded servers,
    // checking it reads the conversation's folder.
    async fn answer_read(script: &mut ScriptedService, servers: &Value) {
        let read = script.next_sent().await;
        assert_eq!(read["method"], "config/read");
        assert_eq!(read["params"]["cwd"], WORKTREE);
        script.answer(
            &read,
            &json!({ "config": { "mcp_servers": servers }, "origins": {} }),
        );
    }

    // The table the call `method` the connection sent next carries; answers it with `answer`, a
    // JSON-RPC `result` or `error` member.
    async fn answer_call(script: &mut ScriptedService, method: &str, answer: Value) -> Value {
        let call = script.next_sent().await;
        assert_eq!(call["method"], method);
        let mut reply = answer;
        reply["jsonrpc"] = json!("2.0");
        reply["id"] = call["id"].clone();
        script.send(&reply);
        call["params"]["config"]["mcp_servers"].clone()
    }

    // A resume sends the servers its own read loads, not the start's: Codex merges the table into
    // the person's config, so a server added between the two stays on unless the resume's own
    // read names it. Killed by reusing the start's read on the resume.
    #[tokio::test]
    async fn a_resume_switches_off_what_its_own_read_loads() {
        let (connection, mut script) = scripted_connection();
        let (connection, settings) = (&connection, &settings());
        let worktree = Path::new(WORKTREE);
        let start = send_with_stale_name_resend(connection, worktree, move |loaded| {
            let params = compose_codex_thread_start_params(settings, table_over(settings, &loaded));
            async move { connection.request("thread/start", &params).await }
        });
        let (started, started_table) = tokio::join!(start, async {
            answer_read(&mut script, &json!({})).await;
            answer_call(&mut script, "thread/start", json!({ "result": {} })).await
        });
        started.expect("the start is answered");
        assert_eq!(started_table, json!({}));

        let resume = send_with_stale_name_resend(connection, worktree, move |loaded| {
            let params = compose_codex_thread_resume_params(
                settings,
                table_over(settings, &loaded),
                "thread".to_owned(),
            );
            async move { connection.request("thread/resume", &params).await }
        });
        let (resumed, resumed_table) = tokio::join!(resume, async {
            answer_read(
                &mut script,
                &json!({ "github": { "url": "https://example.com" } }),
            )
            .await;
            answer_call(&mut script, "thread/resume", json!({ "result": {} })).await
        });
        resumed.expect("the resume is answered");
        assert_eq!(resumed_table, json!({ "github": { "enabled": false } }));
    }

    // A refusal over a configuration that changed since the read is sent once more only on a
    // fresh read that loads other names, and a refusal carrying `data`, or any other refusal,
    // reads nothing again. Killed by failing on a stale name, by resending over the same names,
    // by reading again after a cloud bundle's failure, and by matching another refusal's words.
    #[rstest]
    #[case::load_failure_and_a_changed_read(
        "failed to load configuration: invalid transport in `mcp_servers.gone`",
        None,
        Some(json!({})),
        true
    )]
    #[case::transport_refusal_and_a_changed_read(
        "url is not supported for stdio",
        None,
        Some(json!({})),
        true
    )]
    #[case::load_failure_and_the_same_read(
        "failed to load configuration: invalid transport in `mcp_servers.gone`",
        None,
        Some(json!({ "gone": { "command": "gone-server" } })),
        false
    )]
    #[case::cloud_bundle_failure(
        "failed to load configuration: the cloud bundle did not load",
        Some(json!({ "reason": "cloudConfigBundle" })),
        None,
        false
    )]
    #[case::another_refusal(
        "daybreakEnabled is not supported for ephemeral threads",
        None,
        None,
        false
    )]
    #[tokio::test]
    async fn a_stale_configuration_is_sent_once_more_only_over_other_names(
        #[case] message: &str,
        #[case] data: Option<Value>,
        #[case] reread: Option<Value>,
        #[case] is_resent: bool,
    ) {
        let (connection, mut script) = scripted_connection();
        let (connection, settings) = (&connection, &settings());
        let sending = send_with_stale_name_resend(connection, Path::new(WORKTREE), move |loaded| {
            let params = compose_codex_thread_start_params(settings, table_over(settings, &loaded));
            async move { connection.request("thread/start", &params).await }
        });
        let mut error = json!({ "code": -32600, "message": message });
        if let Some(data) = data {
            error["data"] = data;
        }
        let (sent, ()) = tokio::join!(sending, async {
            answer_read(
                &mut script,
                &json!({ "gone": { "command": "gone-server" } }),
            )
            .await;
            let table = answer_call(&mut script, "thread/start", json!({ "error": error })).await;
            assert_eq!(table, json!({ "gone": { "enabled": false } }));
            if let Some(reread) = &reread {
                answer_read(&mut script, reread).await;
            }
            if is_resent {
                let table = answer_call(&mut script, "thread/start", json!({ "result": {} })).await;
                assert_eq!(table, json!({}));
            }
        });
        assert!(
            script.sent.try_recv().is_err(),
            "nothing else is sent to the service"
        );
        match sent {
            Ok(_reply) => assert!(is_resent, "only a resend over other names is answered"),
            Err(CodexError::ProviderRequest {
                message: refused, ..
            }) => {
                assert!(!is_resent, "a resent call is answered");
                assert_eq!(refused, message);
            }
            Err(other) => panic!("the call failed otherwise: {other}"),
        }
    }
}
