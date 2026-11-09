//! The read each Codex start, resume and fork that carries a tool-server table makes first: one
//! `config/read` of the conversation's folder on the session's own service, whose servers the
//! call's table switches by name, and the whole entry of each server the session switches on that
//! the read does not load, read from the person's own Codex folder once per folder those servers
//! are declared in. A call Codex refuses over a server that changed since the read is sent once
//! more on a fresh read that loads other servers.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use crate::driver::codex::config_read::read_codex_config;
use crate::driver::codex::mcp::sandbox_wrap::compose_codex_sandbox_wrap;
use crate::driver::codex::mcp::session_table::{
    CodexLoadedServers, CodexSessionTableInput, codex_unloaded_bindings,
    compose_codex_session_table,
};
use crate::driver::codex::mcp::{
    codex_binding_folder, observe_in_codex_layers, read_codex_config_layers,
};
use crate::driver::codex::permission_level::codex_repository_root;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::CodexThreadSettings;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::mcp_server::write::{McpServerEntry, McpServerObservedEntry};
use crate::port::tool_server_route::OpenedToolServerRoute;

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
    let read = read_codex_config::<Value>(connection, Some(worktree), false).await?;
    Ok(CodexLoadedServers::of_config(read.config))
}

/// The `mcp_servers` table one start, resume or fork of `settings`' session carries over
/// `loaded`, the call's own read, with the daemon's entries the spawn opened on `route` and each
/// stdio server in the sandbox of `service`, the session's own, where the session runs sandboxed:
/// the whole entry of each server the session switches on that the read does not load is read
/// through `services` from the person's own Codex folder on one service, at most one started for
/// it, with one `config/read` per folder those servers are read at, and none when the read loads
/// them all.
/// Fails as the sandbox's wrap fails, as the folder's service cannot be started or a read fails.
pub(crate) async fn compose_codex_call_table(
    services: &CodexServiceRegistry,
    service: &CodexService,
    settings: &CodexThreadSettings,
    route: Option<&OpenedToolServerRoute>,
    loaded: &CodexLoadedServers,
) -> Result<Map<String, Value>, CodexError> {
    let sandbox_wrap = compose_codex_sandbox_wrap(
        settings,
        service.native_command(),
        service.home().codex_home.clone(),
    )?;
    let worktree = settings.working_directory.as_path();
    let repository_root = codex_repository_root(&settings.profile_folders);
    let mut unloaded_by_folder: BTreeMap<PathBuf, Vec<&McpServerBindingRef>> = BTreeMap::new();
    for binding in codex_unloaded_bindings(&settings.tool_servers, loaded, repository_root) {
        unloaded_by_folder
            .entry(codex_binding_folder(binding, worktree))
            .or_default()
            .push(binding);
    }
    let unloaded_entries = if unloaded_by_folder.is_empty() {
        Vec::new()
    } else {
        services
            .read_on_personal_folder(PersonalFolderRead::Config, |service| async move {
                let connection = service.connection()?;
                let mut entries = Vec::new();
                for (folder, bindings) in unloaded_by_folder {
                    let layers = read_codex_config_layers(&connection, &folder).await?;
                    for binding in bindings {
                        let observed = observe_in_codex_layers(&layers, binding).await?;
                        // A binding whose folder declares no transport for it has nothing to send.
                        if let McpServerObservedEntry::Present(entry) = observed.entry {
                            entries.push((binding.clone(), entry));
                        }
                    }
                }
                Ok::<Vec<(McpServerBindingRef, McpServerEntry)>, CodexError>(entries)
            })
            .await?
    };
    Ok(compose_codex_session_table(CodexSessionTableInput {
        tool_servers: &settings.tool_servers,
        loaded,
        unloaded_entries: &unloaded_entries,
        route,
        repository_root,
        is_copy_fork: false,
        sandbox_wrap: sandbox_wrap.as_ref(),
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

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::mcp::server::McpServerBindingRef;
    use sidekicks_contracts::session::controls::methods::PermissionLevel;

    use super::{compose_codex_call_table, send_with_stale_name_resend};
    use crate::driver::child_records::UnrecordedChildren;
    use crate::driver::codex::mcp::session_table::{
        CodexLoadedServers, CodexSessionTableInput, compose_codex_session_table,
    };
    use crate::driver::codex::permission_level::{CodexProfileFolders, codex_repository_root};
    use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
    use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
    use crate::driver::codex::service::supervisor::CodexProgramResolver;
    use crate::driver::codex::service::supervisor::test_service::{
        UnheardEvents, UnstartedProgram, start_scripted_joined_service,
        test_codex_service_dependencies,
    };
    use crate::driver::codex::session::errors::CodexError;
    use crate::driver::codex::thread::settings::{
        CodexThreadSettings, compose_codex_thread_start_params,
    };
    use crate::driver::codex::transport::connection::scripted_service::{
        ScriptedService, scripted_connection,
    };
    use crate::driver::session_control::SessionToolServer;

    /// The folder the test conversation runs in.
    const WORKTREE: &str = "/work/app";

    /// How long a call the test answers runs before the test fails instead of hanging.
    const SCRIPT_WAIT: Duration = Duration::from_secs(10);

    fn settings() -> CodexThreadSettings {
        CodexThreadSettings {
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
            auto_memory: None,
        }
    }

    // The table of a session with no servers of its own and no route over `loaded`.
    fn table_over(
        settings: &CodexThreadSettings,
        loaded: &CodexLoadedServers,
    ) -> Map<String, Value> {
        compose_codex_session_table(CodexSessionTableInput {
            tool_servers: &settings.tool_servers,
            loaded,
            unloaded_entries: &[],
            route: None,
            repository_root: codex_repository_root(&settings.profile_folders),
            is_copy_fork: false,
            sandbox_wrap: None,
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

    // One call whose set switches on five `user` servers its own read does not load reads the
    // person's folder with one `config/read` on one service and sends each entry whole, and where
    // no service serves the folder it starts one. Killed by a read or a start per server, and by
    // an unloaded server left out of the table.
    #[tokio::test]
    async fn unloaded_servers_are_read_once_per_folder_on_one_service() {
        const NAMES: [&str; 5] = ["alpha", "beta", "gamma", "delta", "epsilon"];
        let mut settings = settings();
        settings.tool_servers = NAMES
            .iter()
            .map(|name| SessionToolServer {
                binding: serde_json::from_value::<McpServerBindingRef>(
                    json!({ "scope": "user", "provider": "codex", "serverName": name }),
                )
                .expect("the test's binding reads"),
                is_enabled: true,
            })
            .collect();
        let entries: Map<String, Value> = NAMES
            .iter()
            .map(|name| {
                (
                    (*name).to_owned(),
                    json!({ "command": format!("{name}-server") }),
                )
            })
            .collect();
        let nothing_loaded = CodexLoadedServers::default();

        let mut joined = start_scripted_joined_service();
        let services = CodexServiceRegistry::holding(&joined);
        let composing =
            compose_codex_call_table(&services, &joined.service, &settings, None, &nothing_loaded);
        let script = &mut joined.script;
        let (table, ()) = tokio::time::timeout(SCRIPT_WAIT, async {
            tokio::join!(composing, async {
                let read = script.next_sent().await;
                assert_eq!(read["method"], "config/read");
                script.answer(
                    &read,
                    &json!({
                        "config": { "mcp_servers": entries },
                        "origins": {},
                        "layers": [{
                            "name": { "type": "user", "file": "/home/person/.codex/config.toml" },
                            "version": "1",
                            "config": { "mcp_servers": entries },
                        }],
                    }),
                );
            })
        })
        .await
        .expect("the call's table settles");
        let table = table.expect("the table is composed");
        assert!(
            joined.script.sent.try_recv().is_err(),
            "one config/read is sent"
        );
        for name in NAMES {
            assert_eq!(
                table[name],
                json!({ "command": format!("{name}-server"), "enabled": true })
            );
        }

        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let program = Arc::new(UnstartedProgram::default());
        let unserved = CodexServiceRegistry::new(
            Arc::new(OneHome(CodexServiceHome {
                codex_home: folder.path().join("home"),
                kind: CodexHomeKind::PersonalFolder,
            })),
            test_codex_service_dependencies(
                folder.path(),
                Arc::clone(&program) as Arc<dyn CodexProgramResolver>,
                Arc::new(UnheardEvents),
                Arc::new(UnrecordedChildren),
            ),
        );
        let started = tokio::time::timeout(
            SCRIPT_WAIT,
            compose_codex_call_table(&unserved, &joined.service, &settings, None, &nothing_loaded),
        )
        .await
        .expect("the call settles");
        assert!(started.is_err(), "the folder's service never came up");
        assert_eq!(program.starts.load(Ordering::SeqCst), 1);
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
        let (connection, mut script, _frames) = scripted_connection();
        let (connection, settings) = (&connection, &settings());
        let sending = send_with_stale_name_resend(connection, Path::new(WORKTREE), move |loaded| {
            let params = compose_codex_thread_start_params(settings, table_over(settings, &loaded));
            async move { connection.request("thread/start", &params).await }
        });
        let mut error = json!({ "code": -32600, "message": message });
        if let Some(data) = data {
            error["data"] = data;
        }
        let answering = async {
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
        };
        let (sent, ()) =
            tokio::time::timeout(SCRIPT_WAIT, async { tokio::join!(sending, answering) })
                .await
                .expect("the call settles");
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
