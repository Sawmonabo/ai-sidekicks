// What a served payload reply IS, and the bounded preview a surface may draw from it.
//
// Split out of `artifact-pane-reading.ts` on the seam that file's own header names:
// that module owns how one READING becomes the next — total reductions over the
// pane's immutable value — and this one owns the decode, which is a different
// subject with a different failure vocabulary. A payload arrives as bytes under a
// declared encoding, and turning those into something a `<pre>` may hold is neither
// a reduction over the reading nor a call on the port; it is the one place in this
// pane where an encoding is read and a `TextDecoder` is run. Kept together the file
// was doing both jobs, which `apps/desktop/AGENTS.md` rejects.
//
// NOTHING HERE REACHES THE PORT OR THE WIRE. It takes one served reply and answers
// with the arm the pane draws.

import type { GrowthArtifactPayloadEncoding, GrowthArtifactRead } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./artifact-bounds.js";

/**
 * What one artifact's payload fetch has established.
 *
 * SIX ARMS, BECAUSE THE WIRE HAS TWO AND EACH OF THEM SPLITS. `GrowthArtifactRead` is
 * a union: the DEFERRED arm hands back a CAS key and no bytes, the INLINE arm hands
 * back the bytes with the encoding to read them by. Both are served answers a surface
 * has to draw — "I asked for the bytes and did not get them inline" is not a failure —
 * so neither collapses into the refusal arm. The inline arm then splits on whether the
 * bytes are text: a payload that decodes is previewable and one that does not is
 * reported as what it is rather than drawn as replacement characters.
 *
 * `not-checked` is its own arm and is not `deferred` with an absent handle: nobody has
 * asked, which rule 8 separates from every answer.
 */
export type ArtifactPayloadReading =
  | { readonly status: "not-checked" }
  | { readonly status: "fetching"; readonly artifactId: string }
  | { readonly status: "refused"; readonly artifactId: string; readonly refusal: ConsoleRefusal }
  /** A key to fetch the bytes with, and no verb registered anywhere that fetches by one. */
  | { readonly status: "deferred"; readonly artifactId: string; readonly payloadHandle: string }
  | {
      readonly status: "text";
      readonly artifactId: string;
      readonly encoding: GrowthArtifactPayloadEncoding;
      /** Bounded at `ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP`; `truncated` says so. */
      readonly text: string;
      readonly truncated: boolean;
    }
  /** Bytes that are not text. Reported, never drawn — and never guessed at. */
  | {
      readonly status: "opaque";
      readonly artifactId: string;
      readonly encoding: GrowthArtifactPayloadEncoding;
      readonly reason: "not-utf8" | "undecodable";
    };

/**
 * How a payload fetch settled, with the arm it reached on the one that served.
 *
 * `ArtifactDeleteOutcome`'s shape and its reason: the caller announces what the fetch
 * ESTABLISHED — a handle, a preview, or bytes that are not text — and reaching back
 * into the reading for it would read whatever the reading held by then rather than
 * what this fetch answered. The `reconciling` arm has no analogue here: nothing this
 * fetch establishes can be undone by a list read landing under it.
 */
export type ArtifactPayloadOutcome =
  | { readonly status: "settled"; readonly payload: ArtifactPayloadReading }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly status: "superseded" };

/**
 * Read one served payload reply as the arm the pane draws.
 *
 * THE DISCRIMINATOR IS THE REPLY'S OWN AND IS NEVER SNIFFED. `payloadEncoding` is
 * present exactly when `payload` is, and the contract is explicit that a reader
 * switches on it rather than inspecting the bytes — which is the whole reason the
 * member exists beside them. So the inline arm is recognised by that member, and the
 * deferred arm is everything else the union admits.
 *
 * A DECODE THAT FAILS IS AN ANSWER, NOT AN ERROR. Base64 that will not decode and
 * bytes that are not UTF-8 are two different facts about a served reply, and neither
 * is a refusal: the daemon answered. Both land on `opaque` with the reason named, so
 * the pane can say which without a preview that would draw replacement characters and
 * call them the payload.
 */
export function artifactPayloadReadingFrom(
  artifactId: string,
  read: GrowthArtifactRead,
): ArtifactPayloadReading {
  if (read.payloadEncoding === undefined) {
    return { status: "deferred", artifactId, payloadHandle: read.payloadHandle };
  }
  const encoding = read.payloadEncoding;
  const decoded = decodedPayloadText(read.payload, encoding);
  if (decoded.status === "opaque") {
    return { status: "opaque", artifactId, encoding, reason: decoded.reason };
  }
  // TRUNCATION IS TWO FACTS, AND EITHER ONE IS ENOUGH: the decoder was handed a prefix
  // of the reply, or what it answered with is longer than the preview draws. The first
  // is the only one a bounded decode can report, and the second still happens whenever
  // a payload that fit under the input bound decodes to more than the cap.
  const truncated =
    decoded.inputBounded || decoded.text.length > ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP;
  return {
    status: "text",
    artifactId,
    encoding,
    text: truncated ? decoded.text.slice(0, ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP) : decoded.text,
    truncated,
  };
}

/** Base64 carries three bytes in every four characters, and pads to a whole group. */
const BASE64_GROUP_CHARACTERS = 4;
const BASE64_GROUP_BYTES = 3;

/** The most bytes one code point can occupy in UTF-8. */
const UTF8_MAX_BYTES_PER_CODE_POINT = 4;

/**
 * Base64 characters that can hold `characterCap` code points of UTF-8 text.
 *
 * A CEILING AND NOT AN ESTIMATE. Four bytes is the widest a code point gets, so this
 * many characters decode to at least the cap however the payload is written — an ASCII
 * log yields four times the cap and is cut back to it, and a payload of astral code
 * points yields exactly the cap. Rounded up to a whole group, so the slice never lands
 * inside one: a partial group is not decodable base64 and would report a served reply
 * as undecodable.
 */
function base64PrefixLengthFor(characterCap: number): number {
  const byteCap = characterCap * UTF8_MAX_BYTES_PER_CODE_POINT;
  return Math.ceil(byteCap / BASE64_GROUP_BYTES) * BASE64_GROUP_CHARACTERS;
}

/**
 * One payload's bytes as text, or why they are not text — decoding only what is drawn.
 *
 * BOUNDED BEFORE THE DECODE AND NOT AFTER IT. The inline arm is bounded by nothing on
 * this side and by nothing named on the wire: `artifactRead` registers no size member,
 * and the reply's own words are "present when `includePayload` was set and the size
 * permitted" — a daemon-side threshold no constant here mirrors, while the ingest cap
 * beside it is a hundred mebibytes. Decoding the whole reply first cost a full binary
 * string, a call per byte, a `Uint8Array`, and a whole decoded string on the renderer's
 * one thread, and then discarded all but two thousand characters of it. The cap's own
 * rationale is about what is DRAWN; this is what makes the cost match it.
 *
 * THE STREAMING DECODE IS WHAT MAKES THE SLICE SAFE, and it is used exactly when the
 * input was sliced. A byte prefix can end inside a multi-byte sequence, which the
 * fatal decoder rejects — so a payload that is perfectly good text would have been
 * reported as `not-utf8` because of where the bound fell. In streaming mode an
 * incomplete trailing sequence is held back instead of thrown for, and the held-back
 * bytes are past the cap in any case. A payload read WHOLE is decoded without it, so a
 * reply that really does end mid-sequence is still reported as what it is.
 */
function decodedPayloadText(
  payload: string,
  encoding: GrowthArtifactPayloadEncoding,
):
  | { readonly status: "text"; readonly text: string; readonly inputBounded: boolean }
  | { readonly status: "opaque"; readonly reason: "not-utf8" | "undecodable" } {
  if (encoding === "utf8") {
    // Already a string: there is nothing to decode, and the caller's own cap is what
    // bounds what is drawn from it.
    return { status: "text", text: payload, inputBounded: false };
  }
  const prefixLength = base64PrefixLengthFor(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP);
  const inputBounded = payload.length > prefixLength;
  const bounded = inputBounded ? payload.slice(0, prefixLength) : payload;
  let bytes: Uint8Array;
  try {
    // RFC 4648 §4, which is what the ingest side encodes with — the two sides of one
    // seam, and `atob` is the platform's own decoder for it.
    const binary = atob(bounded);
    // A written loop rather than `Uint8Array.from(binary, mapper)`: the mapper is one
    // closure call per byte, and `atob` answers with code units in 0-255, which is
    // what `charCodeAt` reads directly.
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    return { status: "opaque", reason: "undecodable" };
  }
  try {
    // `fatal` so a payload that is not text SAYS so. The lenient decoder answers with
    // replacement characters, which a preview would draw as though they were content.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: inputBounded });
    return { status: "text", text, inputBounded };
  } catch {
    return { status: "opaque", reason: "not-utf8" };
  }
}
