// A served artifact read turned into patch text, or the reason it could not be.
//
// A DIFFERENT DECODE FROM THE ARTIFACT PANE'S, AND THE DIFFERENCE IS THE BOUND. That
// pane's `artifact-payload.ts` decodes a PREVIEW: it cuts the bytes at
// `ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP` because what it draws is a screenful and a
// half a person uses to recognise what a payload is. A diff is not previewed — the row
// renderer virtualizes, so a five-thousand-line change set costs a viewport's worth of
// rows however long it is — and a patch cut at preview size would lose whole FILES a
// reader can reach, silently, which is the one thing `Spec-023 §Console Design
// (Meridian)` rule 8 forbids a surface to do with an answer it received.
//
// SO THE BOUND HERE IS THE PARSER'S AND IT REFUSES RATHER THAN TRUNCATES. Past
// `DIFF_PATCH_CHARACTER_CAP` the payload is reported as too large for this surface to
// parse, with the figure named, and no partial change set is drawn.
//
// THE DEFERRED ARM IS A SERVED ANSWER AND NOT A FAILURE. `GrowthArtifactRead` is a union:
// the daemon may hand back a CAS handle instead of bytes, and no verb registered anywhere
// fetches by one. That is a real state of the wire and it settles as its own arm below —
// never as a refusal, which would report the daemon as having failed at something it
// did.

import { DIFF_PATCH_CHARACTER_CAP } from "../../../core/index.js";
import type { GrowthArtifactPayloadEncoding, GrowthArtifactRead } from "../../../bridge/index.js";

/**
 * What one served payload reply yielded for a diff.
 *
 * FOUR ARMS, EACH A DIFFERENT FACT ABOUT A REPLY THAT ARRIVED. The patch itself; a
 * handle where the bytes were not inline; bytes that would not decode as text; and bytes
 * that decoded but are longer than this surface parses. None of the four is a refusal —
 * the daemon answered every one of them — and collapsing any pair would tell a reader
 * the wrong thing about what to do next.
 */
export type DiffPayloadReading =
  | { readonly status: "patch"; readonly patchText: string }
  | { readonly status: "deferred"; readonly payloadHandle: string }
  | {
      readonly status: "opaque";
      readonly encoding: GrowthArtifactPayloadEncoding;
      readonly reason: "not-utf8" | "undecodable";
    }
  | { readonly status: "over-cap"; readonly characterCount: number };

/**
 * Read one served artifact reply as patch text.
 *
 * THE DISCRIMINATOR IS THE REPLY'S OWN. `payloadEncoding` is present exactly when
 * `payload` is, and the contract says a reader switches on it rather than inspecting the
 * bytes — so the inline arm is recognised by that member and the deferred arm is
 * everything else the union admits. Nothing here sniffs a patch out of the bytes.
 */
export function diffPayloadReadingFrom(read: GrowthArtifactRead): DiffPayloadReading {
  if (read.payloadEncoding === undefined) {
    return { status: "deferred", payloadHandle: read.payloadHandle };
  }
  const encoding = read.payloadEncoding;
  const decoded = decodedPatchText(read.payload, encoding);
  if (decoded.status === "opaque") {
    return { status: "opaque", encoding, reason: decoded.reason };
  }
  if (decoded.text.length > DIFF_PATCH_CHARACTER_CAP) {
    return { status: "over-cap", characterCount: decoded.text.length };
  }
  return { status: "patch", patchText: decoded.text };
}

/**
 * The payload as text, or which of the two ways it failed to be any.
 *
 * TWO REASONS AND NOT ONE, because they are different facts about the reply and lead a
 * reader somewhere different: base64 that will not decode at all is a malformed
 * transport payload, and bytes that decode and are not UTF-8 are a binary artifact
 * served where a patch was expected. A single "could not read it" would name neither.
 *
 * WHOLE AND NEVER SLICED, which is what lets the UTF-8 decoder run in FATAL mode with no
 * streaming arm: the preview decode next door slices its input and therefore has to
 * tolerate a prefix ending mid-sequence, and this one does not slice, so a payload that
 * really is not text is reported as such rather than being repaired into replacement
 * characters. The length bound is applied to the DECODED text for the same reason —
 * bounding the base64 instead would cut a multi-byte sequence in half.
 *
 * A `utf8` PAYLOAD IS ALREADY TEXT and takes no decode at all, so that arm cannot fail:
 * whatever crossed the boundary is what the reply said the bytes are.
 */
function decodedPatchText(
  payload: string,
  encoding: GrowthArtifactPayloadEncoding,
):
  | { readonly status: "text"; readonly text: string }
  | { readonly status: "opaque"; readonly reason: "not-utf8" | "undecodable" } {
  if (encoding === "utf8") {
    return { status: "text", text: payload };
  }
  let bytes: Uint8Array;
  try {
    // RFC 4648 §4, the encoding the ingest side uses and the platform's own decoder
    // for it.
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    return { status: "opaque", reason: "undecodable" };
  }
  try {
    return { status: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { status: "opaque", reason: "not-utf8" };
  }
}
