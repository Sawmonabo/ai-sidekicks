// What a served payload reply is, and the bounded preview a surface may draw from it.
//
// This module is the one place in the pane where an encoding is read and a `TextDecoder`
// is run. It reaches neither the port nor the wire: it takes one served reply and answers
// with the arm the pane draws.

import type { GrowthArtifactPayloadEncoding, GrowthArtifactRead } from "../../bridge/index.js";
import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "../../core/index.js";

/**
 * What one artifact's payload fetch has established.
 *
 * `GrowthArtifactRead` is a union: the deferred arm hands back a content-addressed key and
 * no bytes, the inline arm hands back the bytes with the encoding to read them by. Both
 * are served answers a surface has to draw. The inline arm splits on whether the bytes
 * are text: a payload that decodes is previewable, and one that does not is reported as
 * what it is rather than drawn as replacement characters.
 *
 * Before anyone asks there is no reading at all, which is why `ArtifactPaneReading.payload`
 * is absent rather than one more arm here.
 */
export type ArtifactPayloadReading =
  | { readonly status: "fetching"; readonly artifactId: string }
  /** The content-addressed key the bytes are stored under, and no bytes. */
  | { readonly status: "deferred"; readonly artifactId: string; readonly payloadHandle: string }
  | {
      readonly status: "text";
      readonly artifactId: string;
      readonly encoding: GrowthArtifactPayloadEncoding;
      /** Bounded at `ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP`; `truncated` says so. */
      readonly text: string;
      readonly truncated: boolean;
    }
  /** Bytes that are not text. Reported, never drawn. */
  | {
      readonly status: "opaque";
      readonly artifactId: string;
      readonly encoding: GrowthArtifactPayloadEncoding;
      readonly reason: "not-utf8" | "undecodable";
    };

/**
 * How a payload fetch settled, with the arm it reached on the one that served.
 *
 * `superseded` is a fetch whose answer changed nothing on screen and never will: the
 * reader was disposed under it.
 */
export type ArtifactPayloadOutcome =
  | { readonly status: "settled"; readonly payload: ArtifactPayloadReading }
  | { readonly status: "superseded" };

/**
 * Read one served payload reply as the arm the pane draws.
 *
 * The reply's own `payloadEncoding` decides the arm and the bytes are never sniffed: it is
 * present exactly when `payload` is. A decode that fails is an answer, not an error:
 * base64 that will not decode and bytes that are not UTF-8 both land on `opaque` with the
 * reason named.
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
  // Truncated when the decoder was handed a prefix of the reply, or when what it decoded
  // is longer than the preview draws.
  const truncated =
    decoded.inputBounded || decoded.text.length > ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP;
  return {
    status: "text",
    artifactId,
    encoding,
    text: previewBoundedText(decoded.text),
    truncated,
  };
}

/** The UTF-16 code units a surrogate PAIR opens with. A lone one is not a character. */
const HIGH_SURROGATE_FIRST_CODE_UNIT = 0xd800;
const HIGH_SURROGATE_LAST_CODE_UNIT = 0xdbff;

/**
 * The decoded text cut to the preview cap, never through half of a code point.
 *
 * The cap counts UTF-16 code units and a code point is one or two of them, so a plain
 * `slice` can end on the high half of a surrogate pair, which the DOM paints as the
 * replacement character. Backing off one code unit drops the pair whole.
 */
function previewBoundedText(text: string): string {
  if (text.length <= ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP) {
    return text;
  }
  const lastKeptCodeUnit = text.charCodeAt(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP - 1);
  const splitsAPair =
    lastKeptCodeUnit >= HIGH_SURROGATE_FIRST_CODE_UNIT &&
    lastKeptCodeUnit <= HIGH_SURROGATE_LAST_CODE_UNIT;
  return text.slice(
    0,
    splitsAPair
      ? ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP - 1
      : ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
  );
}

/** Base64 carries three bytes in every four characters, and pads to a whole group. */
const BASE64_GROUP_CHARACTERS = 4;
const BASE64_GROUP_BYTES = 3;

/**
 * How wide UTF-8's widest code point is, in bytes.
 *
 * A factor and not a bound: nothing is checked against it, it turns a character cap into
 * the byte length that certainly holds it.
 */
const UTF8_WIDEST_CODE_POINT_BYTES = 4;

/**
 * Base64 characters that can hold `characterCap` code points of UTF-8 text.
 *
 * Four bytes is the widest a code point gets, so this many characters decode to at least
 * the cap however the payload is written. Rounded up to a whole group, because a partial
 * group is not decodable base64 and would report a served reply as undecodable.
 */
function base64PrefixLengthFor(characterCap: number): number {
  const byteCap = characterCap * UTF8_WIDEST_CODE_POINT_BYTES;
  return Math.ceil(byteCap / BASE64_GROUP_BYTES) * BASE64_GROUP_CHARACTERS;
}

/**
 * One payload's bytes as text, or why they are not text, decoding only what is drawn.
 *
 * The input is bounded before the decode, not after it: the inline arm is bounded by
 * nothing on the wire, and decoding a whole payload to draw a screenful of it would cost
 * the renderer's one thread its full length.
 *
 * The streaming decode makes the slice safe and is used exactly when the input was
 * sliced: a byte prefix can end inside a multi-byte sequence, which the fatal decoder
 * would reject and so report good text as `not-utf8`. A payload read whole is decoded
 * without it, so a reply that really ends mid-sequence is still reported as not text.
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
    // Standard base64, which is what the ingest side encodes with.
    const binary = atob(bounded);
    // A written loop rather than `Uint8Array.from(binary, mapper)`, which would cost one
    // closure call per byte.
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    return { status: "opaque", reason: "undecodable" };
  }
  try {
    // `fatal`, because the lenient decoder answers with replacement characters that a
    // preview would draw as though they were content.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: inputBounded });
    return { status: "text", text, inputBounded };
  } catch {
    return { status: "opaque", reason: "not-utf8" };
  }
}
