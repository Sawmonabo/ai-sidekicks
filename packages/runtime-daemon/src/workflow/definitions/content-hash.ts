// A workflow document's content hash and the canonical body it is taken over. Only the hashed
// members reach the preimage, so moving a node, pinning data or tagging never changes the hash.
import {
  pickWorkflowDocumentHashedBody,
  type WorkflowDocument,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { canonicalizeJson } from "../../events/canonicalizer.js";

const CONTENT_HASH_PREFIX = "b3:";
const utf8Decoder = new TextDecoder();

/** A document's hashed body as stored, and the content hash over exactly those bytes. */
export interface WorkflowDocumentHash {
  /** The RFC 8785 canonical JSON of the hashed body, the text a version row stores. */
  readonly canonicalBody: string;
  /** `b3:` and the 64 lowercase hex digits of BLAKE3 over the canonical body's UTF-8 bytes. */
  readonly contentHash: string;
}

/**
 * Canonicalizes a document's hashed body and hashes it. Throws what the canonicalizer throws for
 * a value it refuses, such as a non-finite number.
 */
export function hashWorkflowDocument(document: WorkflowDocument): WorkflowDocumentHash {
  const canonicalBytes = canonicalizeJson(pickWorkflowDocumentHashedBody(document));
  return {
    canonicalBody: utf8Decoder.decode(canonicalBytes),
    contentHash: `${CONTENT_HASH_PREFIX}${bytesToHex(blake3(canonicalBytes))}`,
  };
}
