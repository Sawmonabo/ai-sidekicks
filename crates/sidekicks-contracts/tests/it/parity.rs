//! The parity corpus holds every input today's TypeScript schemas met in their tests, with each
//! schema's verdict. Every key's Rust type, read with serde and checked with garde, must give the
//! same verdict, except on the inputs listed as expected differences on the Rust side.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::alphabet::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use bytes::Bytes;
use flate2::read::GzDecoder;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use sidekicks_contracts::parity::{ParityKey, keys};

/// Base64 as the TypeScript schemas read it: the standard alphabet, padding required, no
/// whitespace, and stray bits after the last byte allowed.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

/// One corpus line: the input as JSON, or as its JSON text where it holds a lone surrogate
/// escape, which serde_json refuses to read. A hand-added line's `note` is for people.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusLine {
    schema: String,
    accepted: bool,
    #[serde(default)]
    input: Option<Box<RawValue>>,
    #[serde(default)]
    input_text: Option<String>,
}

/// A listed difference, naming its input by the SHA-256 of the input's JSON text.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedDifference {
    schema: String,
    side: String,
    reason: String,
    input_sha256: String,
}

fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parity")
}

fn read_json<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let text = fs::read_to_string(corpus_root().join(name)).expect("the corpus file reads");
    serde_json::from_str(&text).expect("the corpus file is JSON")
}

fn corpus_files(folder: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(folder).expect("the corpus folder reads") {
        let path = entry.expect("a corpus entry reads").path();
        if path.is_dir() {
            corpus_files(&path, files);
        } else if path.to_string_lossy().ends_with(".jsonl.gz") {
            files.push(path);
        }
    }
}

/// The type name the corpus expects for `key`: its renamed name, else the export name without
/// `Schema`, first letter upper-cased.
fn expected_type_name(key: &str, renames: &HashMap<String, String>) -> String {
    if let Some(name) = renames.get(key) {
        return name.clone();
    }
    let export = key.split_once('#').map_or(key, |(_, export)| export);
    let name = export.strip_suffix("Schema").unwrap_or(export);
    let mut characters = name.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}

/// The input's JSON with each registered byte member that holds base64 moved into an attachment;
/// a member that is not base64 stays as it is, for the type to refuse. `None` where the text is
/// not JSON serde_json reads, which is then the Rust verdict.
fn with_byte_members(text: &str, pointers: &[String]) -> Option<(Vec<u8>, Vec<Bytes>)> {
    if pointers.is_empty() {
        return Some((text.as_bytes().to_vec(), Vec::new()));
    }
    let mut value: Value = serde_json::from_str(text).ok()?;
    let mut attachments = Vec::new();
    for pointer in pointers {
        let Some(member) = value.pointer_mut(pointer) else {
            continue;
        };
        let Some(bytes) = member
            .as_str()
            .and_then(|base64| BASE64.decode(base64).ok())
        else {
            continue;
        };
        *member = serde_json::json!({ "$bytes": attachments.len() });
        attachments.push(Bytes::from(bytes));
    }
    Some((
        serde_json::to_vec(&value).expect("a JSON value serializes"),
        attachments,
    ))
}

#[test]
fn every_parity_key_gives_the_recorded_verdict() {
    let renames: HashMap<String, String> = read_json("check-names.json");
    let byte_members: HashMap<String, Vec<String>> = read_json("byte-members.json");
    let aliases: HashMap<String, Vec<String>> = read_json("aliases.json");
    let expected: Vec<ExpectedDifference> = read_json("expected-differences.json");
    let mut unmatched: HashMap<(String, String), String> = expected
        .into_iter()
        .filter(|difference| difference.side == "rust")
        .map(|difference| {
            (
                (difference.schema, difference.input_sha256),
                difference.reason,
            )
        })
        .collect();
    let registered: HashMap<&str, &ParityKey> = keys().map(|key| (key.key, key)).collect();

    let mut files = Vec::new();
    corpus_files(&corpus_root(), &mut files);
    files.sort();
    let mut faults = Vec::new();
    let mut corpus_keys = HashSet::new();
    let mut checked_inputs = 0_usize;
    for file in files {
        let relative = file
            .strip_prefix(corpus_root())
            .expect("the file is in the corpus");
        let module = relative.to_string_lossy().replace('\\', "/");
        let module = module
            .strip_suffix(".jsonl.gz")
            .expect("a corpus file name");
        let lines = BufReader::new(GzDecoder::new(File::open(&file).expect("the file opens")));
        for line in lines.lines() {
            let line = line.expect("the corpus decompresses");
            let entry: CorpusLine = serde_json::from_str(&line).expect("a corpus line reads");
            let text = match (&entry.input, &entry.input_text) {
                (Some(input), None) => input.get().to_owned(),
                (None, Some(input_text)) => input_text.clone(),
                (Some(_), Some(_)) | (None, None) => panic!("{module}: a line holds one input"),
            };
            let owner = format!("{module}#{}", entry.schema);
            let alias_keys = aliases.get(&owner).cloned().unwrap_or_default();
            let byte_pointers = byte_members.get(&owner).cloned().unwrap_or_default();
            for key in std::iter::once(owner.clone()).chain(alias_keys) {
                let is_new_key = corpus_keys.insert(key.clone());
                let Some(parity_key) = registered.get(key.as_str()) else {
                    if is_new_key {
                        faults.push(format!("{key}: no Rust type is registered"));
                    }
                    continue;
                };
                let type_name = (parity_key.type_name)();
                if is_new_key && type_name != expected_type_name(&key, &renames) {
                    faults.push(format!("{key}: the Rust type is named {type_name}"));
                }
                checked_inputs += 1;
                let verdict =
                    with_byte_members(&text, &byte_pointers).is_some_and(|(json, attachments)| {
                        (parity_key.check)(&json, attachments).is_ok()
                    });
                if verdict == entry.accepted {
                    continue;
                }
                let digest: String = Sha256::digest(text.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                if unmatched.remove(&(key.clone(), digest)).is_none() {
                    let recorded = if entry.accepted { "accepts" } else { "refuses" };
                    let quoted: String = text.chars().take(300).collect();
                    faults.push(format!(
                        "{key}: today's schema {recorded} and Rust does not: {quoted}"
                    ));
                }
            }
        }
    }
    for key in registered.keys().filter(|key| !corpus_keys.contains(**key)) {
        faults.push(format!("{key}: registered, but the corpus has no such key"));
    }
    for ((schema, _), reason) in unmatched {
        faults.push(format!(
            "{schema}: a listed difference no longer differs ({reason})"
        ));
    }

    assert_eq!(faults, Vec::<String>::new());
    assert!(checked_inputs > 0);
}
