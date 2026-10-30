//! What Claude Code reports of the plugins the probe's process loads with `--plugin-dir-no-mcp`:
//! its `system/init` frame's `plugins[]`, the plugins it loaded, each with its folder and its
//! `<name>@inline` source, and its `plugin_errors`, each naming a plugin by `<name>@inline` or,
//! for a folder that did not load at all, by that folder's path (b:10962973).

use std::path::Path;

use serde::Deserialize;

use crate::driver::claude::mcp::config::ClaudePluginRoot;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

// The source Claude Code gives a plugin loaded from a `--plugin-dir-no-mcp` folder, after its
// name.
const INLINE_PLUGIN_SOURCE: &str = "@inline";

/// The plugins one `system/init` frame lists as loaded and their load errors, each in its order.
#[derive(Default, Deserialize)]
pub(super) struct PluginLoadReport {
    #[serde(default, deserialize_with = "read_lenient")]
    plugins: Option<LenientList<LoadedPlugin>>,
    #[serde(default, deserialize_with = "read_lenient")]
    plugin_errors: Option<LenientList<PluginLoadError>>,
}

// One row of `plugins`: the folder it loaded from and its source.
#[derive(Deserialize)]
struct LoadedPlugin {
    #[serde(default, deserialize_with = "read_lenient")]
    path: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    source: Option<String>,
}

// One entry of `plugin_errors`: the plugin it names, its message, and the folder of a plugin that
// did not load at all.
#[derive(Deserialize)]
struct PluginLoadError {
    #[serde(default, deserialize_with = "read_lenient")]
    plugin: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    path: Option<String>,
}

lenient_object!(PluginLoadReport, LoadedPlugin, PluginLoadError);

/// What Claude Code made of one plugin the probe loaded.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum PluginLoad<'report> {
    /// It is among the plugins Claude Code loaded.
    Accepted,
    /// It is not, with the message of the first load error naming it, where one does.
    Refused(Option<&'report str>),
}

impl PluginLoadReport {
    /// Reads a `system/init` frame's text; one that is no object, or lists nothing, lists no
    /// plugin and no error.
    pub(super) fn read(text: &str) -> Self {
        let mut deserializer = serde_json::Deserializer::from_str(text);
        <Self as Lenient>::read(&mut deserializer)
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    /// Whether Claude Code loaded `plugin`: accepted where a `plugins` row names its folder or
    /// the name it loads it under, refused otherwise. A refusal's message is the first error that
    /// names its folder, or, for an error with no folder, the name it loads it under; the probe
    /// keeps plugins of one loaded name in separate processes, so that name points at one plugin.
    pub(super) fn load_of(&self, plugin: &ClaudePluginRoot) -> PluginLoad<'_> {
        let inline_name = format!("{}{INLINE_PLUGIN_SOURCE}", plugin.loaded_name);
        let is_its_folder = |path: &str| Path::new(path) == plugin.root;
        let is_loaded = self
            .plugins
            .iter()
            .flat_map(|plugins| &plugins.0)
            .any(|row| {
                row.path.as_deref().is_some_and(is_its_folder)
                    || row.source.as_deref() == Some(inline_name.as_str())
            });
        if is_loaded {
            return PluginLoad::Accepted;
        }
        let message = self
            .plugin_errors
            .iter()
            .flat_map(|errors| &errors.0)
            .find(|error| match error.path.as_deref() {
                Some(path) => is_its_folder(path),
                None => error.plugin.as_deref() == Some(inline_name.as_str()),
            })
            .and_then(|error| error.message.as_deref());
        PluginLoad::Refused(message)
    }
}
