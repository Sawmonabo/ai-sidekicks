//! The observe of MCP server bindings in Codex's own config: one `config/read` with its layers at
//! a binding's folder, which serves every binding observed there, each binding's entry read from
//! the layer that holds it, with the user layer's version a write expects and the files a write's
//! failure names.

use std::path::{Path, PathBuf};

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_std::file::real_location::resolve_real_location;

use crate::driver::codex::config_read::{
    CODEX_CONFIG_FILE_NAME, CodexConfigFileError, CodexConfigLayer, CodexConfigLayerSource,
    read_codex_config,
};
use crate::driver::codex::mcp::config::server_entry::{has_transport, read_switch};
use crate::driver::codex::rules::CODEX_PROJECT_SETTINGS_FOLDER;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::mcp_server::write::{McpServerEntry, McpServerObserved, McpServerObservedEntry};

/// The folder Codex's config is read at for `binding`: its root for a `project` or `local`
/// binding, whose layer Codex lists only there, and `elsewhere` for any other, whose layer is the
/// same at any folder.
pub(crate) fn codex_binding_folder(binding: &McpServerBindingRef, elsewhere: &Path) -> PathBuf {
    match binding {
        McpServerBindingRef::Project { scope_ref, .. }
        | McpServerBindingRef::Local { scope_ref, .. } => PathBuf::from(scope_ref.as_str()),
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => elsewhere.to_path_buf(),
    }
}

/// Codex's config layers as `connection`'s service reads them at `cwd`, highest precedence first,
/// one read serving every binding whose folder `cwd` is. Fails as the read fails.
pub(crate) async fn read_codex_config_layers(
    connection: &CodexAppServerConnection,
    cwd: &Path,
) -> Result<Vec<CodexConfigLayer>, CodexError> {
    let read = read_codex_config::<Value>(connection, cwd, true).await?;
    Ok(read.layers.unwrap_or_default())
}

/// What Codex's config holds for `binding`, read at `cwd`, the binding's folder. Fails as the read
/// fails and as [`observe_in_codex_layers`] does.
pub(crate) async fn observe_codex_mcp_server(
    connection: &CodexAppServerConnection,
    binding: &McpServerBindingRef,
    cwd: &Path,
) -> Result<McpServerObserved, CodexError> {
    let layers = read_codex_config_layers(connection, cwd).await?;
    observe_in_codex_layers(&layers, binding).await
}

/// What `layers`, Codex's config layers read at `binding`'s folder, hold for `binding`: a `user` or
/// `local` binding from the user layer, a `project` one from the layer of its root's `.codex`
/// folder, matched through any link, and any other binding as absent, since no layer Codex writes
/// holds it. Fails with `CodexError::Transport` where `layers` hold no user layer, and with
/// `CodexError::ConfigUnreadable` where a project's folder cannot be resolved.
pub(crate) async fn observe_in_codex_layers(
    layers: &[CodexConfigLayer],
    binding: &McpServerBindingRef,
) -> Result<McpServerObserved, CodexError> {
    let user_layer = layers
        .iter()
        .find(|layer| layer.name.kind == CodexConfigLayerSource::USER_KIND)
        .ok_or_else(|| CodexError::Transport {
            detail: "Codex's \"config/read\" reply lists no user layer.".to_owned(),
            cause: None,
        })?;
    let server_name = binding.server_name().as_str();
    let (entry, config_files) = match binding {
        McpServerBindingRef::User { .. } | McpServerBindingRef::Local { .. } => (
            read_entry(&user_layer.config, server_name),
            non_project_files(layers),
        ),
        McpServerBindingRef::Project { scope_ref, .. } => {
            let folder = Path::new(scope_ref.as_str()).join(CODEX_PROJECT_SETTINGS_FOLDER);
            let entry = find_project_layer(layers, &folder)
                .await?
                .map_or(McpServerObservedEntry::Absent, |layer| {
                    read_entry(&layer.config, server_name)
                });
            // The matched layer's folder is this one, so the path is built from the binding.
            let file = folder.join(CODEX_CONFIG_FILE_NAME);
            (entry, vec![file.to_string_lossy().into_owned()])
        }
        McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => {
            (McpServerObservedEntry::Absent, non_project_files(layers))
        }
    };
    Ok(McpServerObserved {
        entry,
        config_version: Some(user_layer.version.clone()),
        config_files,
    })
}

// The project layer of the `.codex` folder `folder`: the one naming it as written, else the one
// naming the folder it really is, so a project reached through a link finds its layer. Fails as a
// folder cannot be resolved.
async fn find_project_layer<'layers>(
    layers: &'layers [CodexConfigLayer],
    folder: &Path,
) -> Result<Option<&'layers CodexConfigLayer>, CodexError> {
    let project_layers: Vec<(&'layers CodexConfigLayer, &'layers Path)> = layers
        .iter()
        .filter(|layer| layer.name.kind == CodexConfigLayerSource::PROJECT_KIND)
        .filter_map(|layer| Some((layer, Path::new(layer.name.dot_codex_folder.as_deref()?))))
        .collect();
    if let Some((layer, _)) = project_layers
        .iter()
        .find(|(_, layer_folder)| *layer_folder == folder)
    {
        return Ok(Some(*layer));
    }
    if project_layers.is_empty() {
        return Ok(None);
    }
    let real_folder = resolve_folder(folder).await?;
    for (layer, layer_folder) in project_layers {
        if resolve_folder(layer_folder).await? == real_folder {
            return Ok(Some(layer));
        }
    }
    Ok(None)
}

// `folder` with every link in it resolved, the names below its deepest existing folder kept as
// written. Fails with the resolve's failure, named after the config file in `folder`.
async fn resolve_folder(folder: &Path) -> Result<PathBuf, CodexError> {
    resolve_real_location(folder).await.map_err(|failure| {
        CodexError::ConfigUnreadable(CodexConfigFileError::Read {
            path: folder.join(CODEX_CONFIG_FILE_NAME),
            failure,
        })
    })
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
        .filter(|layer| layer.name.kind != CodexConfigLayerSource::PROJECT_KIND)
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

    use crate::driver::codex::transport::connection::scripted_service::scripted_connection;

    let (connection, mut script, _frames) = scripted_connection();
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
    use sidekicks_platforms::{make_folder_link, real_path};

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
            McpServerObservedEntry::Present(McpServerEntry::from_json(
                json!({"command": "project-docs"})
            ))
        );
        assert_eq!(observed.config_version.as_deref(), Some("sha256:user"));
        assert_eq!(observed.config_files, ["/work/app/.codex/config.toml"]);

        let observed = observe_scripted(&user, Path::new("/home/person"), &layers).await;
        assert_eq!(
            observed.entry,
            McpServerObservedEntry::Present(McpServerEntry::from_json(
                json!({"command": "user-docs"})
            ))
        );
        assert_eq!(
            observed.config_files,
            ["/home/person/.codex/config.toml", "mdm"]
        );
    }

    // A project reached through a link finds the layer Codex names by the folder it really is.
    // Killed by matching a project's `.codex` folder only as written.
    #[tokio::test]
    async fn a_project_reached_through_a_link_reads_its_own_layer() {
        let scratch = tempfile::tempdir().expect("the test makes a folder");
        let real_root = scratch.path().join("app");
        std::fs::create_dir_all(real_root.join(".codex")).expect("the project's folder is made");
        let linked_root = scratch.path().join("linked");
        make_folder_link(&real_root, &linked_root).expect("the link is made");
        let dot_codex_folder =
            real_path(&real_root.join(".codex")).expect("the project's folder resolves");
        let layers = json!([
            {
                "name": {"type": "project", "dotCodexFolder": dot_codex_folder},
                "version": "sha256:project",
                "config": {"mcp_servers": {"docs": {"command": "project-docs"}}},
            },
            {
                "name": {"type": "user", "file": "/home/person/.codex/config.toml"},
                "version": "sha256:user",
                "config": {},
            },
        ]);
        let project: McpServerBindingRef = serde_json::from_value(json!({
            "scope": "project", "provider": "codex", "scopeRef": linked_root, "serverName": "docs"
        }))
        .expect("the test's binding reads");

        let observed = observe_scripted(&project, &linked_root, &layers).await;

        assert_eq!(
            observed.entry,
            McpServerObservedEntry::Present(McpServerEntry::from_json(
                json!({"command": "project-docs"})
            ))
        );
    }
}
