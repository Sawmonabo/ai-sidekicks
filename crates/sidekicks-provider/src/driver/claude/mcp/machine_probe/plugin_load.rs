//! What Claude Code reports of the plugins the probe's process loads with `--plugin-dir-no-mcp`:
//! its `reload_plugins` answer's `plugins`, the plugins it loaded, each with its folder and its
//! `<name>@inline` source. The answer counts the plugins that failed to load but gives no words
//! for them.

use std::path::Path;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::claude::mcp::config::ClaudePluginRoot;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

// The source Claude Code gives a plugin loaded from a `--plugin-dir-no-mcp` folder, after its
// name.
const INLINE_PLUGIN_SOURCE: &str = "@inline";

/// The plugins one `reload_plugins` answer lists as loaded, in its order.
#[derive(Default, Deserialize)]
pub(super) struct PluginLoadReport {
    #[serde(default, deserialize_with = "read_lenient")]
    plugins: Option<LenientList<LoadedPlugin>>,
}

// One row of `plugins`: the folder it loaded from and its source.
#[derive(Deserialize)]
struct LoadedPlugin {
    #[serde(default, deserialize_with = "read_lenient")]
    path: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    source: Option<String>,
}

lenient_object!(PluginLoadReport, LoadedPlugin);

impl PluginLoadReport {
    /// Reads a `reload_plugins` answer; an absent one, one that is no object, or one that lists
    /// nothing, lists no plugin.
    pub(super) fn read(reply: Option<&RawValue>) -> Self {
        reply
            .and_then(|reply| {
                let mut deserializer = serde_json::Deserializer::from_str(reply.get());
                <Self as Lenient>::read(&mut deserializer).ok().flatten()
            })
            .unwrap_or_default()
    }

    /// Whether Claude Code loaded `plugin`: a `plugins` row names its folder or the name it loads
    /// it under. The probe keeps plugins of one loaded name in separate processes, so that name
    /// points at one plugin.
    pub(super) fn is_loaded(&self, plugin: &ClaudePluginRoot) -> bool {
        let inline_name = format!("{}{INLINE_PLUGIN_SOURCE}", plugin.loaded_name);
        self.plugins
            .iter()
            .flat_map(|plugins| &plugins.0)
            .any(|row| {
                row.path
                    .as_deref()
                    .is_some_and(|path| Path::new(path) == plugin.root)
                    || row.source.as_deref() == Some(inline_name.as_str())
            })
    }
}
