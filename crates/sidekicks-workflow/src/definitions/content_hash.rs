//! A workflow document's content hash and the canonical body it is taken over. Only the hashed
//! members reach the preimage, so moving a node, pinning data or tagging never changes the hash.

use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowContentHash, WorkflowDocumentHashedBody,
};
use sidekicks_store::events::canonicalizer::{CanonicalizationRefusal, canonicalize_json};

/// What every content hash starts with: the hash function's name.
const CONTENT_HASH_PREFIX: &str = "b3:";

/// A document's hashed body as stored, and the content hash over exactly those bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowDocumentHash {
    /// The RFC 8785 canonical JSON of the hashed body, the text a version row stores.
    pub(crate) canonical_body: String,
    /// `b3:` and the 64 lowercase hex digits of BLAKE3 over the canonical body's UTF-8 bytes.
    pub(crate) content_hash: WorkflowContentHash,
}

/// Canonicalizes a document's hashed body and hashes it; refuses what the canonicalizer refuses,
/// such as a body nesting deeper than its ceiling.
pub(crate) fn hash_workflow_body(
    hashed_body: &WorkflowDocumentHashedBody,
) -> Result<WorkflowDocumentHash, CanonicalizationRefusal> {
    let body = serde_json::to_value(hashed_body)?;
    let canonical_bytes = canonicalize_json(&body)?;
    let content_hash = format!(
        "{CONTENT_HASH_PREFIX}{}",
        blake3::hash(canonical_bytes.as_bytes()).to_hex()
    );
    Ok(WorkflowDocumentHash {
        canonical_body: std::str::from_utf8(canonical_bytes.as_bytes())
            .expect("RFC 8785 writes UTF-8")
            .to_owned(),
        content_hash: WorkflowContentHash(
            NonEmptyText::new(content_hash).expect("a content hash starts with its prefix"),
        ),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::workflow::definition::document::{
        WorkflowDocument, pick_workflow_document_hashed_body,
    };

    use super::hash_workflow_body;

    /// A document whose objects, `params` among them, list their keys in one order.
    const KEYS_FORWARD: &str = concat!(
        r#"{"schemaVersion":"2","name":"Nightly","description":"Reads the notes","#,
        r#""trigger":{"id":"trigger","kind":"trigger.manual","kindVersion":1,"name":"Start","#,
        r#""order":0,"params":{}},"nodes":[{"id":"read","kind":"files.read","kindVersion":1,"#,
        r#""name":"Read notes","order":0,"params":{"path":"notes.md","encoding":"utf8"}}],"#,
        r#""edges":[]}"#,
    );

    /// The same document with every object's keys in reverse order.
    const KEYS_REVERSED: &str = concat!(
        r#"{"edges":[],"nodes":[{"params":{"encoding":"utf8","path":"notes.md"},"order":0,"#,
        r#""name":"Read notes","kindVersion":1,"kind":"files.read","id":"read"}],"#,
        r#""trigger":{"params":{},"order":0,"name":"Start","kindVersion":1,"#,
        r#""kind":"trigger.manual","id":"trigger"},"description":"Reads the notes","#,
        r#""name":"Nightly","schemaVersion":"2"}"#,
    );

    /// A drift in either value orphans every stored version's hash, and a hash that moved with key
    /// order would mint versions for nothing. Mutation: hash `serde_json::to_vec` in place of the
    /// canonicalizer.
    #[test]
    fn a_document_hashes_to_its_pinned_text_and_hash_whatever_its_key_order() {
        let document: WorkflowDocument = serde_json::from_value(json!({
            "schemaVersion": "2",
            "name": "Nightly",
            "trigger": {
                "id": "trigger", "kind": "trigger.manual", "kindVersion": 1, "name": "Start",
                "order": 0, "params": {},
            },
            "nodes": [{
                "id": "read", "kind": "files.read", "kindVersion": 1, "name": "Read notes",
                "order": 0, "params": { "path": "notes.md" },
            }],
            "edges": [{
                "id": "trigger-to-read", "source": "trigger", "sourceHandle": "outputs/main/0",
                "target": "read", "targetHandle": "inputs/main/0",
            }],
        }))
        .expect("the document reads");
        let hash = hash_workflow_body(&pick_workflow_document_hashed_body(&document))
            .expect("the document hashes");
        assert_eq!(
            hash.canonical_body,
            concat!(
                r#"{"edges":[{"id":"trigger-to-read","source":"trigger","#,
                r#""sourceHandle":"outputs/main/0","target":"read","#,
                r#""targetHandle":"inputs/main/0"}],"name":"Nightly","nodes":[{"id":"read","#,
                r#""kind":"files.read","kindVersion":1,"name":"Read notes","order":0,"#,
                r#""params":{"path":"notes.md"}}],"trigger":{"id":"trigger","#,
                r#""kind":"trigger.manual","kindVersion":1,"name":"Start","order":0,"#,
                r#""params":{}}}"#,
            )
        );
        assert_eq!(
            hash.content_hash.0.as_str(),
            "b3:09ce55947a4da688ad71e87f4303c39e7cc5e2a06eb3c49d1d4977b317f25e86"
        );

        let [forward, reversed] = [KEYS_FORWARD, KEYS_REVERSED].map(|text| {
            let document: WorkflowDocument = serde_json::from_str(text).expect("the text reads");
            hash_workflow_body(&pick_workflow_document_hashed_body(&document))
                .expect("the document hashes")
        });
        assert_eq!(forward, reversed);
    }
}
