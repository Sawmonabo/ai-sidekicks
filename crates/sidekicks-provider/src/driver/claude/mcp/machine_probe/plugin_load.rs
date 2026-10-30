//! What Claude Code reports of the plugins the probe's process loads with `--plugin-dir`: whether
//! every plugin folder its `initialize` listed loaded at launch (the reply's `plugins_applied`,
//! b:11107837), and each plugin's load error from its `system/init` frame (`plugin_errors`,
//! b:10962973), which names a plugin by `<name>@inline` or, for a folder that did not load at all,
//! by that folder's path.

use std::path::Path;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::claude::mcp::config::ClaudePluginRoot;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

// The source Claude Code gives a plugin loaded from a `--plugin-dir` folder, after its name.
const INLINE_PLUGIN_SOURCE: &str = "@inline";

// The member of an `initialize` reply the probe reads.
#[derive(Default, Deserialize)]
struct InitializeReply {
    #[serde(default, deserialize_with = "read_lenient")]
    plugins_applied: Option<bool>,
}

/// Whether the `initialize` reply says every plugin folder the request listed loaded at launch;
/// `false` where it says not, says nothing or is unreadable.
pub(super) fn are_plugins_applied(initialize: Option<&RawValue>) -> bool {
    initialize
        .and_then(|reply| {
            let mut deserializer = serde_json::Deserializer::from_str(reply.get());
            <InitializeReply as Lenient>::read(&mut deserializer)
                .ok()
                .flatten()
        })
        .and_then(|reply| reply.plugins_applied)
        .unwrap_or(false)
}

/// The plugin load errors one `system/init` frame lists, in its order.
#[derive(Default, Deserialize)]
pub(super) struct PluginLoadErrors {
    #[serde(default, deserialize_with = "read_lenient")]
    plugin_errors: Option<LenientList<PluginLoadError>>,
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

lenient_object!(InitializeReply, PluginLoadErrors, PluginLoadError);

impl PluginLoadErrors {
    /// Reads a `system/init` frame's text; one that is no object, or lists none, lists no error.
    pub(super) fn read(text: &str) -> Self {
        let mut deserializer = serde_json::Deserializer::from_str(text);
        <Self as Lenient>::read(&mut deserializer)
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    /// The message of the first error naming `plugin`, by the name Claude Code loads it under or
    /// by its folder; `None` where none names it or the one that does has no message.
    pub(super) fn message_for(&self, plugin: &ClaudePluginRoot) -> Option<&str> {
        let inline_name = format!("{}{INLINE_PLUGIN_SOURCE}", plugin.loaded_name);
        self.plugin_errors
            .iter()
            .flat_map(|errors| &errors.0)
            .find(|error| {
                error.plugin.as_deref() == Some(inline_name.as_str())
                    || error
                        .path
                        .as_deref()
                        .is_some_and(|path| Path::new(path) == plugin.root)
            })
            .and_then(|error| error.message.as_deref())
    }
}
