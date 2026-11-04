//! The observe of one MCP server binding in Codex's own config: one `config/read` with its layers,
//! the binding's entry read from the layer that holds it, with the user layer's version a write
//! expects and the files a write's failure names.

use std::path::Path;

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use crate::driver::codex::config_read::{
    CODEX_CONFIG_FILE_NAME, CodexConfigLayer, read_codex_config,
};
use crate::driver::codex::mcp::config::server_entry::{has_transport, read_switch};
use crate::driver::codex::rules::CODEX_PROJECT_SETTINGS_FOLDER;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::mcp_server::write::{McpServerEntry, McpServerObserved, McpServerObservedEntry};

/// The kind of the layer that holds the person's own Codex config.
const USER_LAYER_KIND: &str = "user";

/// The kind of a layer that holds a project's own Codex config.
const PROJECT_LAYER_KIND: &str = "project";

/// What Codex's config holds for `binding`, read at `cwd`: a `user` or `local` binding from the
/// user layer, a `project` one from the layer of its root's `.codex` folder, and any other binding
/// as absent, since no layer Codex writes holds it. Fails as the read fails, and with
/// `CodexError::Transport` where the reply lists no user layer.
pub(super) async fn observe_codex_mcp_server(
    connection: &CodexAppServerConnection,
    binding: &McpServerBindingRef,
    cwd: &Path,
) -> Result<McpServerObserved, CodexError> {
    let read = read_codex_config::<Value>(connection, cwd, true).await?;
    let layers = read.layers.unwrap_or_default();
    let user_layer = layers
        .iter()
        .find(|layer| layer.name.kind == USER_LAYER_KIND)
        .ok_or_else(|| CodexError::Transport {
            detail: "Codex's \"config/read\" reply lists no user layer.".to_owned(),
            cause: None,
        })?;
    let server_name = binding.server_name().as_str();
    let (entry, config_files) = match binding {
        McpServerBindingRef::User { .. } | McpServerBindingRef::Local { .. } => (
            read_entry(&user_layer.config, server_name),
            non_project_files(&layers),
        ),
        McpServerBindingRef::Project { scope_ref, .. } => {
            let folder = Path::new(scope_ref.as_str()).join(CODEX_PROJECT_SETTINGS_FOLDER);
            let entry = layers
                .iter()
                .find(|layer| is_project_layer_at(layer, &folder))
                .map_or(McpServerObservedEntry::Absent, |layer| {
                    read_entry(&layer.config, server_name)
                });
            // The matched layer's folder equals this one, so the path is built from the binding.
            let file = folder.join(CODEX_CONFIG_FILE_NAME);
            (entry, vec![file.to_string_lossy().into_owned()])
        }
        McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => {
            (McpServerObservedEntry::Absent, non_project_files(&layers))
        }
    };
    Ok(McpServerObserved {
        entry,
        config_version: Some(user_layer.version.clone()),
        config_files,
    })
}

// Whether `layer` is the project layer of the `.codex` folder `folder`, compared as paths.
fn is_project_layer_at(layer: &CodexConfigLayer, folder: &Path) -> bool {
    layer.name.kind == PROJECT_LAYER_KIND
        && layer
            .name
            .dot_codex_folder
            .as_deref()
            .is_some_and(|dot_codex_folder| Path::new(dot_codex_folder) == folder)
}

// The entry `layer_config` holds under `server_name`: a declaration where it names a transport,
// else the switch it sets, switched on where it sets none.
fn read_entry(layer_config: &Value, server_name: &str) -> McpServerObservedEntry {
    let Some(entry) = layer_config
        .get(MCP_SERVERS_KEY)
        .and_then(|servers| servers.get(server_name))
    else {
        return McpServerObservedEntry::Absent;
    };
    match entry.as_object() {
        Some(members) if has_transport(entry) => {
            McpServerObservedEntry::Present(McpServerEntry::from_members(members.clone()))
        }
        Some(_) | None => McpServerObservedEntry::Switch(read_switch(entry).unwrap_or(true)),
    }
}

// Each layer's file but a project's, or its kind where it has no file, in the reply's order.
fn non_project_files(layers: &[CodexConfigLayer]) -> Vec<String> {
    layers
        .iter()
        .filter(|layer| layer.name.kind != PROJECT_LAYER_KIND)
        .map(|layer| {
            layer
                .name
                .file
                .clone()
                .unwrap_or_else(|| layer.name.kind.clone())
        })
        .collect()
}

/// Observes `binding` at `cwd` over a scripted Codex service that answers the one `config/read`
/// with `layers`, checking the request asks for the layers and nothing else is sent.
#[cfg(test)]
pub(super) async fn observe_scripted(
    binding: &McpServerBindingRef,
    cwd: &Path,
    layers: &Value,
) -> McpServerObserved {
    use serde_json::json;

    use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
    use crate::driver::codex::transport::connection::CodexConnectionHandlers;
    use crate::driver::codex::transport::connection::scripted_service::connect_scripted_service;

    // The largest message the scripted connection takes, far above any a test sends.
    const MESSAGE_LIMIT: usize = 1 << 20;

    let (events, _frames) = CodexDetachedFrames::new();
    let (connection, mut script) = connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
            token_refresher: None,
        },
    );
    let (observed, ()) = tokio::join!(observe_codex_mcp_server(&connection, binding, cwd), async {
        let request = script.next_sent().await;
        assert_eq!(request["method"], "config/read");
        assert_eq!(request["params"]["includeLayers"], true);
        script.answer(
            &request,
            &json!({ "config": {}, "origins": {}, "layers": layers }),
        );
    });
    let observed = observed.expect("the scripted read answers");
    assert!(
        script.sent.try_recv().is_err(),
        "nothing else is sent to the service"
    );
    observed
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerBindingRef;

    use super::observe_scripted;
    use crate::driver::mcp_server::write::{McpServerEntry, McpServerObservedEntry};

    // A project binding reads the layer of its root's `.codex` folder, switched off or not, never
    // the user layer's same-named server, and names that folder's file alone; a user binding names
    // every other layer's file, or its kind. Killed by reading the user layer for a project, by
    // skipping a disabled project layer, by taking a path from the reply for a project, and by
    // listing the project layer or dropping a fileless one for a user binding.
    #[tokio::test]
    async fn a_project_binding_reads_its_own_layer_and_names_its_own_file() {
        let layers = json!([
            {
                "name": {"type": "project", "dotCodexFolder": "/work/app/.codex/"},
                "version": "sha256:project",
                "disabledReason": "the project is not trusted",
                "config": {"mcp_servers": {"docs": {"command": "project-docs"}}},
            },
            {
                "name": {"type": "user", "file": "/home/person/.codex/config.toml"},
                "version": "sha256:user",
                "config": {"mcp_servers": {"docs": {"command": "user-docs"}}},
            },
            {
                "name": {"type": "mdm", "domain": "com.openai.codex", "key": "config_toml_base64"},
                "version": "sha256:managed",
                "config": {},
            },
        ]);
        let project: McpServerBindingRef = serde_json::from_value(json!({
            "scope": "project", "provider": "codex", "scopeRef": "/work/app", "serverName": "docs"
        }))
        .expect("the test's binding reads");
        let user: McpServerBindingRef = serde_json::from_value(json!({
            "scope": "user", "provider": "codex", "serverName": "docs"
        }))
        .expect("the test's binding reads");

        let observed = observe_scripted(&project, Path::new("/work/app"), &layers).await;
        assert_eq!(
            observed.entry,
            McpServerObservedEntry::Present(McpServerEntry::from_members(
                serde_json::from_value(json!({"command": "project-docs"}))
                    .expect("the test's entry is an object")
            ))
        );
        assert_eq!(observed.config_version.as_deref(), Some("sha256:user"));
        assert_eq!(observed.config_files, ["/work/app/.codex/config.toml"]);

        let observed = observe_scripted(&user, Path::new("/home/person"), &layers).await;
        assert_eq!(
            observed.entry,
            McpServerObservedEntry::Present(McpServerEntry::from_members(
                serde_json::from_value(json!({"command": "user-docs"}))
                    .expect("the test's entry is an object")
            ))
        );
        assert_eq!(
            observed.config_files,
            ["/home/person/.codex/config.toml", "mdm"]
        );
    }
}
