//! A Codex plugin written into a test's plugin home, which the MCP config and sign-in tests read.

use std::path::Path;

use serde_json::{Value, json};

/// Writes a plugin in Codex's own format under `plugin_home`, its servers inline in its manifest.
pub(super) fn write_codex_plugin(
    plugin_home: &Path,
    marketplace: &str,
    plugin: &str,
    servers: &Value,
) {
    let folder = plugin_home.join(format!("plugins/cache/{marketplace}/{plugin}/1.0.0"));
    std::fs::create_dir_all(folder.join(".codex-plugin")).expect("the plugin folder is made");
    std::fs::write(
        folder.join(".codex-plugin/plugin.json"),
        json!({"name": plugin, "mcpServers": servers}).to_string(),
    )
    .expect("the manifest is written");
}
