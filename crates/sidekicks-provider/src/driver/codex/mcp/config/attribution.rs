//! Which bindings Codex's config layers declare, read from `config/read` replies alone: each layer
//! that declares a server with its transport binds it, each higher layer naming the same server
//! supersedes or switches it off there, and each server's view is Codex's own merge at that root.

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_platforms::PathRules;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::config_read::CodexConfigLayer;
use crate::driver::codex::mcp::config::server_entry::{
    has_transport, is_switched_off, read_codex_server_entry, read_switch, sets_other_members,
};
use crate::driver::codex::mcp::config::{CodexMcpConfigReading, CodexRootConfigRead};
use crate::driver::mcp_server::read::{McpRootReading, McpServerDeclaration, McpServerPolicy};

// The config table of MCP servers, by name.
const MCP_SERVERS_KEY: &str = "mcp_servers";
// The file a project's `.codex` folder holds its config in.
const PROJECT_CONFIG_FILE_NAME: &str = "config.toml";

// What a layer is to the person: their own, a project's, or an administrator's. A layer of another
// kind (the launch's own flags, or a kind this reader does not know) binds nothing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LayerRole {
    User,
    Project,
    Administrator,
}

// One layer Codex merges, with its role, its servers and the file it is written in.
struct RankedLayer<'read> {
    role: LayerRole,
    servers: Option<&'read Map<String, Value>>,
    file: Option<PlacedPath>,
}

impl RankedLayer<'_> {
    fn server(&self, name: &str) -> Option<&Value> {
        self.servers.and_then(|servers| servers.get(name))
    }
}

// A declaration being gathered across the reads, and whether its view came from a read where no
// project layer names its server, the view a server outside any project has.
struct DeclarationDraft {
    declaration: McpServerDeclaration,
    is_view_outside_projects: bool,
}

/// The bindings, views and per-root provider-loaded sets the `config/read` replies in `reads`
/// declare, the plugins' servers aside.
pub(crate) fn attribute_codex_mcp_servers(reads: &[CodexRootConfigRead]) -> CodexMcpConfigReading {
    let provider = DESCRIPTOR.provider_id();
    let mut drafts: Vec<DeclarationDraft> = Vec::new();
    let mut roots = Vec::new();
    let mut is_machine_managed = false;
    for root_read in reads {
        let root = root_read.root.as_ref();
        let effective = root_read
            .read
            .config
            .get(MCP_SERVERS_KEY)
            .and_then(Value::as_object);
        // Codex lists its layers highest precedence first; a layer it ignores binds nothing.
        let layers: Vec<RankedLayer<'_>> = root_read
            .read
            .layers
            .iter()
            .flatten()
            .filter(|layer| layer.disabled_reason.is_none())
            .filter_map(|layer| rank_layer(layer, root))
            .collect();
        let mut provider_loaded: Vec<McpServerBindingRef> = Vec::new();
        for (index, layer) in layers.iter().enumerate() {
            for (name, entry) in layer.servers.into_iter().flatten() {
                if !has_transport(entry) {
                    continue;
                }
                let Ok(server_name) = McpServerName::new(name.clone()) else {
                    continue;
                };
                let binding = match layer.role {
                    LayerRole::User => McpServerBindingRef::User {
                        provider: provider.clone(),
                        server_name,
                    },
                    LayerRole::Project => {
                        let Some(root) = root else {
                            continue;
                        };
                        McpServerBindingRef::Project {
                            provider: provider.clone(),
                            scope_ref: root.path.clone(),
                            place: root.place.clone(),
                            server_name,
                        }
                    }
                    LayerRole::Administrator => {
                        is_machine_managed = true;
                        McpServerBindingRef::Managed {
                            provider: provider.clone(),
                            server_name,
                        }
                    }
                };
                // Codex's own merge at this root; the layer's entry only where the merge lost it.
                let view_entry = effective
                    .and_then(|servers| servers.get(name))
                    .filter(|merged| has_transport(merged))
                    .unwrap_or(entry);
                let Some(declared) = read_codex_server_entry(view_entry) else {
                    continue;
                };
                let (superseded_in, disabled_in) = read_overrides(&layers[..index], layer, name);
                if root.is_some()
                    && layer.role != LayerRole::User
                    && is_loaded_without_user_layers(&layers, name)
                    && !provider_loaded.contains(&binding)
                {
                    provider_loaded.push(binding.clone());
                }
                let is_view_outside_projects = !layers
                    .iter()
                    .any(|named| named.role == LayerRole::Project && named.server(name).is_some());
                gather(
                    &mut drafts,
                    DeclarationDraft {
                        declaration: McpServerDeclaration {
                            binding,
                            config: declared.config,
                            superseded_in,
                            disabled_in,
                            is_read_only: layer.role == LayerRole::Administrator,
                            sign_in_client: declared.sign_in_client,
                        },
                        is_view_outside_projects,
                    },
                );
            }
        }
        if let Some(root) = root {
            roots.push(McpRootReading {
                root: root.clone(),
                // Codex keeps no list of project servers out of a project's sessions.
                kept_out_server_names: Vec::new(),
                provider_loaded,
            });
        }
    }
    CodexMcpConfigReading {
        declarations: drafts.into_iter().map(|draft| draft.declaration).collect(),
        roots,
        is_machine_managed,
        // Codex's config layers carry no allow or deny list of servers.
        server_policy: McpServerPolicy::default(),
    }
}

// `layer`'s role, servers and file; `None` for a layer that binds nothing.
fn rank_layer<'read>(
    layer: &'read CodexConfigLayer,
    root: Option<&PlacedPath>,
) -> Option<RankedLayer<'read>> {
    let source = &layer.name;
    let role = match source.kind.as_str() {
        "user" => LayerRole::User,
        "project" => LayerRole::Project,
        "packagedDefaults"
        | "mdm"
        | "system"
        | "enterpriseManaged"
        | "legacyManagedConfigTomlFromFile"
        | "legacyManagedConfigTomlFromMdm" => LayerRole::Administrator,
        _ => return None,
    };
    let file = match role {
        LayerRole::Project => source.dot_codex_folder.as_deref().and_then(|folder| {
            let place = root.and_then(|root| root.place.clone());
            // A root in a WSL distribution is read in its Linux form.
            let rules = if place.is_some() {
                PathRules::Posix
            } else {
                PathRules::NATIVE
            };
            let folder = folder.trim_end_matches(|character| rules.is_separator(character));
            let path = format!("{folder}{}{PROJECT_CONFIG_FILE_NAME}", rules.separator());
            Some(PlacedPath {
                path: FilesystemPath::new(path).ok()?,
                place,
            })
        }),
        // An MDM or enterprise layer is written in no file.
        LayerRole::User | LayerRole::Administrator => source.file.as_deref().and_then(|file| {
            Some(PlacedPath {
                path: FilesystemPath::new(file.to_owned()).ok()?,
                place: None,
            })
        }),
    };
    Some(RankedLayer {
        role,
        servers: layer.config.get(MCP_SERVERS_KEY).and_then(Value::as_object),
        file,
    })
}

// The files of the layers in `higher` whose entry for `name` takes the place of `layer`'s
// declaration (a declaration of another binding, or an override of any member but the switch),
// and of those whose entry switches it off.
fn read_overrides(
    higher: &[RankedLayer<'_>],
    layer: &RankedLayer<'_>,
    name: &str,
) -> (Vec<PlacedPath>, Vec<PlacedPath>) {
    let mut superseded_in: Vec<PlacedPath> = Vec::new();
    let mut disabled_in: Vec<PlacedPath> = Vec::new();
    for overriding in higher {
        let Some(entry) = overriding.server(name) else {
            continue;
        };
        // A layer in no file cannot be named; a profile over the user's own file is the same file.
        let Some(file) = overriding.file.as_ref() else {
            continue;
        };
        if Some(file) == layer.file.as_ref() {
            continue;
        }
        if has_transport(entry) {
            // A declaration in a layer of the same role is the same binding.
            if overriding.role != layer.role {
                push_once(&mut superseded_in, file);
            }
            continue;
        }
        if is_switched_off(entry) {
            push_once(&mut disabled_in, file);
        }
        if sets_other_members(entry) {
            push_once(&mut superseded_in, file);
        }
    }
    (superseded_in, disabled_in)
}

// Whether a session whose Codex home holds none of the person's own config loads `name`: the
// highest project or administrator layer that sets its switch decides, and it is on by default.
fn is_loaded_without_user_layers(layers: &[RankedLayer<'_>], name: &str) -> bool {
    layers
        .iter()
        .filter(|layer| layer.role != LayerRole::User)
        .find_map(|layer| read_switch(layer.server(name)?))
        .unwrap_or(true)
}

// Adds `draft` to `drafts`, or folds it into the draft of the same binding another read gave: their
// files joined, and the view taken from a read where no project names the server where one does.
fn gather(drafts: &mut Vec<DeclarationDraft>, draft: DeclarationDraft) {
    let Some(kept) = drafts
        .iter_mut()
        .find(|kept| kept.declaration.binding == draft.declaration.binding)
    else {
        drafts.push(draft);
        return;
    };
    for file in &draft.declaration.superseded_in {
        push_once(&mut kept.declaration.superseded_in, file);
    }
    for file in &draft.declaration.disabled_in {
        push_once(&mut kept.declaration.disabled_in, file);
    }
    if draft.is_view_outside_projects && !kept.is_view_outside_projects {
        kept.declaration.config = draft.declaration.config;
        kept.declaration.sign_in_client = draft.declaration.sign_in_client;
        kept.is_view_outside_projects = true;
    }
}

fn push_once(files: &mut Vec<PlacedPath>, file: &PlacedPath) {
    if !files.contains(file) {
        files.push(file.clone());
    }
}
