//! Which bindings Codex's config layers declare, read from `config/read` replies alone: each layer
//! that declares a server with its transport binds it, each higher layer naming the same server
//! supersedes or switches it off there, and each server's view is Codex's own merge at that root,
//! or its own layer's entry where a layer of another role declares the name over it.

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::inventory::{
    McpManagedLayer, McpManagedLayerKind, McpOverrideOrigin,
};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_platforms::PathRules;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::config_read::CodexConfigLayer;
use crate::driver::codex::mcp::config::server_entry::{
    CodexServerTransport, has_transport, is_switched_off, read_codex_server_entry,
    read_codex_server_transport, read_switch, sets_other_members,
};
use crate::driver::codex::mcp::config::{
    CodexLoadedServer, CodexMcpConfigReading, CodexRootConfigRead,
};
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::mcp_server::read::{McpRootReading, McpServerDeclaration, McpServerPolicy};

// The file a project's `.codex` folder holds its config in.
const PROJECT_CONFIG_FILE_NAME: &str = "config.toml";
/// The config table of the plugins' switches and their servers' overrides.
pub(crate) const PLUGINS_KEY: &str = "plugins";
/// The member of the plugins' table holding the switch every plugin without its own takes.
pub(crate) const PLUGINS_DEFAULT_KEY: &str = "_default";

// What a layer is to the person: their own, a project's, or an administrator's. A layer of another
// kind (the launch's own flags, or a kind this reader does not know) binds nothing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LayerRole {
    User,
    Project,
    Administrator,
}

// One layer Codex merges, with its role, its servers and where it comes from: the file it is
// written in, or for an administrator's layer in no file, its kind.
struct RankedLayer<'read> {
    role: LayerRole,
    servers: Option<&'read Map<String, Value>>,
    origin: Option<McpOverrideOrigin>,
}

impl RankedLayer<'_> {
    fn server(&self, name: &str) -> Option<&Value> {
        self.servers.and_then(|servers| servers.get(name))
    }
}

// A declaration being gathered across the reads, the transport its view declares, and whether its
// view came from a read where no project layer names its server, the view a server outside any
// project has.
struct DeclarationDraft {
    declaration: McpServerDeclaration,
    transport: Option<CodexServerTransport>,
    is_view_outside_projects: bool,
}

/// The bindings, views, per-root provider-loaded sets and loaded servers the `config/read` replies
/// in `reads` declare, the plugins' servers aside, and the plugins any config layer names.
pub(crate) fn attribute_codex_mcp_servers(reads: &[CodexRootConfigRead]) -> CodexMcpConfigReading {
    let provider = DESCRIPTOR.provider_id();
    let mut drafts: Vec<DeclarationDraft> = Vec::new();
    let mut roots = Vec::new();
    let mut loaded_servers: Vec<CodexLoadedServer> = Vec::new();
    let mut person_plugin_keys: Vec<String> = Vec::new();
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
        for key in root_read
            .read
            .layers
            .iter()
            .flatten()
            .filter_map(|layer| layer.config.get(PLUGINS_KEY)?.as_object())
            .flat_map(Map::keys)
        {
            if key != PLUGINS_DEFAULT_KEY && !person_plugin_keys.contains(key) {
                person_plugin_keys.push(key.clone());
            }
        }
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
                let merged = effective.and_then(|servers| servers.get(name));
                // Layers rank highest first, so the first that declares the name is what loads.
                if !loaded_servers.iter().any(|loaded| {
                    loaded.root.as_ref() == root
                        && loaded.binding.server_name() == binding.server_name()
                }) {
                    loaded_servers.push(CodexLoadedServer {
                        root: root.cloned(),
                        binding: binding.clone(),
                        is_switched_on: merged.and_then(read_switch).unwrap_or(true),
                    });
                }
                // A binding another role's declaration takes the place of shows its own entry,
                // since the merge there is the other binding's; every other shows Codex's own
                // merge at this root, or its layer's entry where the merge lost it.
                let is_taken_over = layers[..index].iter().any(|higher| {
                    higher.role != layer.role && higher.server(name).is_some_and(has_transport)
                });
                let view_entry = merged
                    .filter(|merged| !is_taken_over && has_transport(merged))
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
                            is_switch_kept_by_daemon: false,
                            tool_defaults: declared.tool_defaults,
                            organization_managed: None,
                        },
                        transport: read_codex_server_transport(view_entry),
                        is_view_outside_projects,
                    },
                );
            }
        }
        if let Some(root) = root {
            roots.push(McpRootReading {
                root: root.clone(),
                // The requirements' allow list fills it once the read has every declaration.
                kept_out_server_names: Vec::new(),
                provider_loaded,
            });
        }
    }
    let mut transports = Vec::with_capacity(drafts.len());
    let mut declarations = Vec::with_capacity(drafts.len());
    for draft in drafts {
        if let Some(transport) = draft.transport {
            transports.push((draft.declaration.binding.clone(), transport));
        }
        declarations.push(draft.declaration);
    }
    CodexMcpConfigReading {
        declarations,
        transports,
        roots,
        is_machine_managed,
        // Codex's config layers carry no allow or deny list; its requirements file does.
        server_policy: McpServerPolicy::default(),
        // The plugins' servers join after this read.
        plugin_keys: Vec::new(),
        // The requirements' allow lists fill these once the read has every declaration.
        home_kept_out_server_names: Vec::new(),
        refused_when_sent: Vec::new(),
        loaded_servers,
        person_plugin_keys,
    }
}

/// Where the config at each of `reads` switches off the server `server` of the plugin keyed
/// `plugin_key` (`<plugin>@<marketplace>`), as Codex decides it: the highest layer that sets the
/// plugin's own switch, else the highest that sets every plugin's default, and the highest layer
/// that sets the server's own switch under the plugin's table. A layer of no known origin that
/// switches it off cannot be named.
pub(crate) fn find_plugin_switch_offs(
    reads: &[CodexRootConfigRead],
    plugin_key: &str,
    server: &str,
) -> Vec<McpOverrideOrigin> {
    let mut disabled_in: Vec<McpOverrideOrigin> = Vec::new();
    for root_read in reads {
        let layers: Vec<&CodexConfigLayer> = root_read
            .read
            .layers
            .iter()
            .flatten()
            .filter(|layer| layer.disabled_reason.is_none())
            .collect();
        // The highest layer whose plugins' table sets the switch `read` finds, and its value.
        let decide = |read: &dyn Fn(&Map<String, Value>) -> Option<bool>| {
            layers.iter().find_map(|layer| {
                let plugins = layer.config.get(PLUGINS_KEY)?.as_object()?;
                read(plugins).map(|is_on| (is_on, *layer))
            })
        };
        let plugin_switch = decide(&|plugins| read_switch(plugins.get(plugin_key)?))
            .or_else(|| decide(&|plugins| read_switch(plugins.get(PLUGINS_DEFAULT_KEY)?)));
        let server_switch = decide(&|plugins| {
            read_switch(plugins.get(plugin_key)?.get(MCP_SERVERS_KEY)?.get(server)?)
        });
        for (is_on, layer) in [plugin_switch, server_switch].into_iter().flatten() {
            let origin =
                rank_layer(layer, root_read.root.as_ref()).and_then(|ranked| ranked.origin);
            if let (false, Some(origin)) = (is_on, origin) {
                push_once(&mut disabled_in, &origin);
            }
        }
    }
    disabled_in
}

// `layer`'s role, servers and origin; `None` for a layer that binds nothing.
fn rank_layer<'read>(
    layer: &'read CodexConfigLayer,
    root: Option<&PlacedPath>,
) -> Option<RankedLayer<'read>> {
    let source = &layer.name;
    let role = match source.kind.as_str() {
        "user" => LayerRole::User,
        "project" => LayerRole::Project,
        "mdm"
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
        LayerRole::User | LayerRole::Administrator => source.file.as_deref().and_then(|file| {
            Some(PlacedPath {
                path: FilesystemPath::new(file.to_owned()).ok()?,
                place: None,
            })
        }),
    };
    // An MDM or enterprise layer is written in no file, so it is named by its kind.
    let fileless_kind = match source.kind.as_str() {
        "mdm" | "legacyManagedConfigTomlFromMdm" => Some(McpManagedLayerKind::DeviceManagement),
        "enterpriseManaged" => Some(McpManagedLayerKind::OrganizationCloud),
        _ => None,
    };
    let origin = file.map(McpOverrideOrigin::Placed).or_else(|| {
        fileless_kind
            .map(|managed_layer| McpOverrideOrigin::ManagedLayer(McpManagedLayer { managed_layer }))
    });
    Some(RankedLayer {
        role,
        servers: layer.config.get(MCP_SERVERS_KEY).and_then(Value::as_object),
        origin,
    })
}

// The origins of the layers in `higher` whose entry for `name` takes the place of `layer`'s
// declaration (a declaration of another binding, or an override of any member but the switch),
// and of those whose entry switches it off.
fn read_overrides(
    higher: &[RankedLayer<'_>],
    layer: &RankedLayer<'_>,
    name: &str,
) -> (Vec<McpOverrideOrigin>, Vec<McpOverrideOrigin>) {
    let mut superseded_in: Vec<McpOverrideOrigin> = Vec::new();
    let mut disabled_in: Vec<McpOverrideOrigin> = Vec::new();
    for overriding in higher {
        let Some(entry) = overriding.server(name) else {
            continue;
        };
        // A layer of no known origin cannot be named; a profile over the user's own file is the
        // same file.
        let Some(file) = overriding.origin.as_ref() else {
            continue;
        };
        if Some(file) == layer.origin.as_ref() {
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
        kept.transport = draft.transport;
        kept.is_view_outside_projects = true;
    }
}

fn push_once(files: &mut Vec<McpOverrideOrigin>, file: &McpOverrideOrigin) {
    if !files.contains(file) {
        files.push(file.clone());
    }
}
