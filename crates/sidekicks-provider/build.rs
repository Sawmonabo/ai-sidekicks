//! Generates Codex's app-server protocol types the provider crate sends, and the notification and
//! server request methods the protocol names, from the schema bundle of one Codex release,
//! vendored byte for byte and checked by its hash.

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

use serde_json::Value;
use sha3::{Digest, Sha3_256};
use typify::{TypeSpace, TypeSpaceSettings};

/// Codex's app-server protocol schemas: the release's own compressed bundle, which its
/// `app-server generate-json-schema --experimental` writes out.
const CODEX_PROTOCOL_BUNDLE: &str =
    "vendor/codex-app-server-protocol/app-server-exports-experimental.json.zst";

/// The SHA3-256 of [`CODEX_PROTOCOL_BUNDLE`] as the release ships it.
const CODEX_PROTOCOL_BUNDLE_SHA3_256: &str =
    "4edb2d126ff9eba4cb3de19454c88c207e0e26066e6d67c95a1c0c5b8e8594b1";

/// The Codex release tag [`CODEX_PROTOCOL_BUNDLE`] comes from, named in a hash mismatch. The
/// bundle names no version of its own, so its hash is the build's one check of the release; a
/// newer release moves the file and its hash whole.
const CODEX_PROTOCOL_RELEASE: &str = "rust-v0.163.0";

/// The protocol types the daemon sends, generated with every type they reach.
const CODEX_SENT_TYPES: [&str; 30] = [
    "ThreadStartParams",
    "ThreadResumeParams",
    "ThreadForkParams",
    "TurnStartParams",
    "TurnSteerParams",
    "TurnInterruptParams",
    "ReviewStartParams",
    "ThreadGoalSetParams",
    "ThreadGoalClearParams",
    "ThreadApproveGuardianDeniedActionParams",
    "ModelListParams",
    "ThreadSettingsUpdateParams",
    "ThreadBackgroundTerminalsListParams",
    "ThreadBackgroundTerminalsTerminateParams",
    "ThreadBackgroundTerminalsCleanParams",
    "ThreadUnsubscribeParams",
    "SkillsListParams",
    "ThreadTurnsListParams",
    "ThreadItemsListParams",
    "ThreadLoadedListParams",
    "HooksListParams",
    "GetAccountParams",
    "ThreadDeleteParams",
    "ThreadCompactStartParams",
    "ConfigValueWriteParams",
    "ConfigReadParams",
    "ThreadRevertParams",
    "GetAccountRateLimitsParams",
    "ThreadSetNameParams",
    "ThreadReadParams",
];

/// The sent types whose members carry absent, `null` and a value as three meanings, which
/// generated code would fold into two; each is written by hand where its path names.
const CODEX_HAND_WRITTEN_TYPES: [(&str, &str); 2] = [
    (
        "TurnStartParams",
        "crate::codex::thread::settings::CodexTurnStartParams",
    ),
    (
        "ThreadSettingsUpdateParams",
        "crate::codex::thread::settings::CodexThreadSettingsUpdateParams",
    ),
];

/// The item-history cursor, a string or an item anchor, which generated code reads as two
/// flattened members and cannot write, and the hand-written type that sends the string the
/// previous page named.
const CODEX_ITEMS_CURSOR: (&str, &str) = (
    "ThreadItemsListCursor",
    "crate::codex::session::history::CodexItemsCursor",
);

/// The member of the generated thread params that carries absent, `null` and a value as three
/// meanings, the definition it is pointed at, and the hand-written type that keeps all three.
const CODEX_SERVICE_TIER_CHANGE: (&str, &str, &str) = (
    "serviceTier",
    "ServiceTierChange",
    "crate::codex::thread::settings::CodexServiceTierChange",
);

/// The generated file, in the build's output folder.
const CODEX_PROTOCOL_OUTPUT: &str = "codex_app_server_protocol.rs";

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed={CODEX_PROTOCOL_BUNDLE}");
    write_codex_protocol(&PathBuf::from(env::var("OUT_DIR")?).join(CODEX_PROTOCOL_OUTPUT))
}

/// The SHA3-256 of `bytes`, in lowercase hex.
fn sha3_256_hex(bytes: &[u8]) -> String {
    Sha3_256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            write!(hex, "{byte:02x}").expect("writing to a String does not fail");
            hex
        })
}

/// Writes to `output` the protocol types the daemon sends and the notification and server request
/// methods the protocol names, once the bundle's hash is the release's.
fn write_codex_protocol(output: &Path) -> Result<(), Box<dyn Error>> {
    let compressed = fs::read(CODEX_PROTOCOL_BUNDLE)?;
    let bundle_hash = sha3_256_hex(&compressed);
    if bundle_hash != CODEX_PROTOCOL_BUNDLE_SHA3_256 {
        return Err(format!(
            "{CODEX_PROTOCOL_BUNDLE} hashes to {bundle_hash}, not the {CODEX_PROTOCOL_RELEASE} \
             release's {CODEX_PROTOCOL_BUNDLE_SHA3_256}"
        )
        .into());
    }
    let bundle: Value = serde_json::from_slice(&zstd::decode_all(compressed.as_slice())?)?;
    let schemas = &bundle["json_schema"];

    let mut definitions = read_schema_file(schemas, "codex_app_server_protocol.v2.schemas.json")?
        .get_mut("definitions")
        .map(Value::take)
        .ok_or("the v2 schema file holds no definitions")?;
    let definitions = definitions
        .as_object_mut()
        .ok_or("the v2 schema file's definitions are not an object")?;
    point_service_tier_at_its_change(definitions)?;
    let mut settings = TypeSpaceSettings::default();
    let (_, change_name, change_type) = CODEX_SERVICE_TIER_CHANGE;
    for (type_name, replacement) in CODEX_HAND_WRITTEN_TYPES
        .into_iter()
        .chain([(change_name, change_type), CODEX_ITEMS_CURSOR])
    {
        settings.with_replacement(type_name, replacement, std::iter::empty());
    }
    let mut type_space = TypeSpace::new(&settings);
    let mut sent_types = Vec::new();
    for type_name in reached_types(definitions)? {
        let schema = definitions
            .get_mut(&type_name)
            .map(Value::take)
            .ok_or_else(|| format!("the v2 schema file names no {type_name}"))?;
        sent_types.push((type_name, serde_json::from_value(schema)?));
    }
    type_space.add_ref_types(sent_types)?;

    let generated = format!(
        "{}\n/// Every notification method the protocol names, in its schema's order.\n\
         pub(crate) const SERVER_NOTIFICATION_METHODS: &[&str] = &[{}];\n\
         /// Every request method the service may send, in its schema's order.\n\
         pub(crate) const SERVER_REQUEST_METHODS: &[&str] = &[{}];\n",
        type_space.to_stream(),
        read_methods(schemas, "ServerNotification.json")?,
        read_methods(schemas, "ServerRequest.json")?,
    );
    fs::write(output, generated)?;
    Ok(())
}

/// The methods the arms of the bundle's message schema file `name` name, in order, each a quoted
/// Rust string followed by a comma.
fn read_methods(schemas: &Value, name: &str) -> Result<String, Box<dyn Error>> {
    let messages = read_schema_file(schemas, name)?;
    let mut methods = String::new();
    for arm in messages["oneOf"]
        .as_array()
        .ok_or_else(|| format!("{name} has no oneOf list"))?
    {
        let method = arm["properties"]["method"]["enum"][0]
            .as_str()
            .ok_or_else(|| format!("a {name} arm names no method"))?;
        write!(methods, "{method:?}, ")?;
    }
    Ok(methods)
}

/// Points each generated sent type's service tier member at one definition that the hand-written
/// change type replaces, since generated code would read its `null` as absent and never send it.
fn point_service_tier_at_its_change(
    definitions: &mut serde_json::Map<String, Value>,
) -> Result<(), Box<dyn Error>> {
    let (member, change_name, _) = CODEX_SERVICE_TIER_CHANGE;
    let generated_types = CODEX_SENT_TYPES.into_iter().filter(|type_name| {
        !CODEX_HAND_WRITTEN_TYPES
            .iter()
            .any(|(hand_written, _)| hand_written == type_name)
    });
    for type_name in generated_types {
        let properties = definitions
            .get_mut(type_name)
            .and_then(|schema| schema.get_mut("properties"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| format!("the v2 schema file's {type_name} names no members"))?;
        if let Some(schema) = properties.get_mut(member) {
            if *schema != serde_json::json!({ "type": ["string", "null"] }) {
                return Err(
                    format!("{type_name}'s {member} is no longer a nullable string").into(),
                );
            }
            *schema = serde_json::json!({ "$ref": format!("#/definitions/{change_name}") });
        }
    }
    definitions.insert(
        change_name.to_owned(),
        serde_json::json!({ "type": ["string", "null"] }),
    );
    Ok(())
}

/// The bundle's schema file `name`, which the bundle holds as JSON text.
fn read_schema_file(schemas: &Value, name: &str) -> Result<Value, Box<dyn Error>> {
    let text = schemas[name]
        .as_str()
        .ok_or_else(|| format!("the bundle holds no {name}"))?;
    Ok(serde_json::from_str(text)?)
}

/// The names of the sent types and every definition they reach through a `$ref`.
fn reached_types(
    definitions: &serde_json::Map<String, Value>,
) -> Result<BTreeSet<String>, Box<dyn Error>> {
    let mut reached = BTreeSet::new();
    let mut waiting: Vec<String> = CODEX_SENT_TYPES.map(str::to_owned).to_vec();
    while let Some(type_name) = waiting.pop() {
        if !reached.insert(type_name.clone()) {
            continue;
        }
        let schema = definitions
            .get(&type_name)
            .ok_or_else(|| format!("the v2 schema file names no {type_name}"))?;
        let mut references = BTreeSet::new();
        collect_references(schema, &mut references);
        waiting.extend(references);
    }
    Ok(reached)
}

/// Adds to `references` the definition named by each `$ref` under `schema`.
fn collect_references(schema: &Value, references: &mut BTreeSet<String>) {
    match schema {
        Value::Object(members) => {
            for (key, member) in members {
                match (key.as_str(), member) {
                    ("$ref", Value::String(target)) => {
                        if let Some(name) = target.strip_prefix("#/definitions/") {
                            references.insert(name.to_owned());
                        }
                    }
                    _ => collect_references(member, references),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_references(item, references);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}
