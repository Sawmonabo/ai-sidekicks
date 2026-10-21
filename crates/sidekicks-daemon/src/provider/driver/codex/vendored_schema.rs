//! Reads the schema files of the vendored Codex release bundle, for the tests that hold the
//! driver's hand-written wire shapes to the release the build generates from.

use serde_json::Value;

/// The vendored release bundle, compressed, embedded so the test binary carries no checkout path.
const BUNDLE: &[u8] = include_bytes!(
    "../../../../vendor/codex-app-server-protocol/app-server-exports-experimental.json.zst"
);

/// The schema file `name` of the vendored bundle, parsed; the bundle carries each file as text.
pub(super) fn vendored_schema_file(name: &str) -> Value {
    let exports: Value =
        serde_json::from_slice(&zstd::decode_all(BUNDLE).expect("the bundle decompresses"))
            .expect("the bundle is JSON");
    serde_json::from_str(
        exports["json_schema"][name]
            .as_str()
            .unwrap_or_else(|| panic!("the bundle carries {name} as text")),
    )
    .unwrap_or_else(|error| panic!("{name} is JSON: {error}"))
}
