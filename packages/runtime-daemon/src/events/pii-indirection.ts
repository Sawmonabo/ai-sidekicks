// PII indirection codec — the sole producer of non-null
// `session_events.pii_payload` and `session_events.content_payload` bytes.
//
// It seals the two partitions a row may carry — the user's PII under the
// user's content key, the machine-authored prose under the session content key
// — adds the content description members to `payload`, parses the composed
// envelope against its registered variant, and measures its canonical size for
// the append path's relay-frame ceiling. The append path (`EventLogService`)
// writes the row; this module touches no database.
//
// THE CIPHERTEXT BRANDS ARE MINTED HERE AND NOWHERE ELSE. No constructor, cast
// helper, or brand symbol is exported for either, so a persistence helper
// typing its column parameter `PiiPayloadCiphertext | null` can be handed a
// non-null value only by code that ran this codec.
//
// An `event_maintenance` event is never purged, so a partition on one could
// never be removed; its `pii_payload` and `content_payload` are NULL by
// construction. `RawEventInput` makes attaching
// either partition a compile error and `writeEventWithPii` refuses the category
// at runtime too, because a value that crossed a serialization boundary or an
// `as` cast is one TypeScript never checked.
//
// REFUSALS ANSWERABLE FROM THE INPUT ALONE PRECEDE THE ENCRYPT STEP. AES-256-GCM
// takes a fresh random 96-bit nonce per write (NIST SP 800-38D section 8.2), so a
// re-run produces different ciphertext; refusing before the seal keeps a rejected
// append from spending a seal at all.
//
// `PiiEncryptor` is an interface owned here; the composition root injects the
// AES-256-GCM implementation. `RawEventInput` is shaped to receive the
// `{payload, piiPayload}` split the emitter performs, and this module never
// performs that split itself.
//
// Refusals here throw a plain `Error`: no caller yet needs to discriminate one
// from any other throw, and `ipc/domain-error.ts`'s `DaemonDomainError` is where
// such a code would go.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EventCategory, EventEnvelope, SessionEvent } from "@ai-sidekicks/contracts";
import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
} from "@ai-sidekicks/contracts";

import { canonicalizeEvent, canonicalizeJson, normalizeOccurredAt } from "./canonicalizer.js";

// --------------------------------------------------------------------------
// Brands.
// --------------------------------------------------------------------------

/**
 * The encrypted bytes destined for the `session_events.pii_payload` column —
 * the AEAD output of the injected {@link PiiEncryptor}, admitted into the type
 * system at exactly one site: {@link writeEventWithPii}.
 *
 * {@link PiiEncryptor} returns a BARE `Uint8Array` on purpose: were it to return
 * the brand, its implementation would have to mint one, and any caller could
 * then invoke the encryptor directly and hand the result to the INSERT.
 */
export type PiiPayloadCiphertext = Uint8Array & { readonly __brand: "PiiPayloadCiphertext" };

/**
 * The sealed machine-authored body, exactly as `session_events.content_payload`
 * will hold it: `iv || ciphertext || tag`, AES-256-GCM under the session content
 * key with AAD `session_id || event_id`.
 */
type ContentPayloadCiphertext = Uint8Array & {
  readonly __brand: "ContentPayloadCiphertext";
};

// --------------------------------------------------------------------------
// The machine-authored content partition.
// --------------------------------------------------------------------------

/** AES-256-GCM initialization-vector width — 96 bits, the NIST SP 800-38D size. */
const CONTENT_SEAL_IV_BYTES = 12;

/** AES-256-GCM authentication-tag width. */
const CONTENT_SEAL_TAG_BYTES = 16;

/** Width of the session content key this module seals under. */
const CONTENT_SEAL_KEY_BYTES = 32;

/**
 * The machine-authored body to seal, and the key to seal it under.
 *
 * THE KEY ARRIVES AS MATERIAL, NOT AS A LOOKUP. Resolving it means reading
 * `session_content_keys` and unwrapping under the daemon master key, which can
 * block on a human; the caller does that once, ahead of this call, and hands the
 * bytes in.
 */
export interface EventContentInput {
  /**
   * The machine-authored prose — an assistant message body, a reasoning-update
   * body, a tool call's arguments / result / error body, or the denial a
   * provider's own reviewer sent when it blocked an action.
   *
   * MAY EXCEED {@link CONTENT_PAYLOAD_PLAINTEXT_MAX}. An over-bound body is
   * truncated at a codepoint boundary rather than refused: refusing the append
   * would drop the turn, which is a worse and less honest outcome than storing a
   * prefix that says it is one.
   */
  readonly body: string;
  /** The 32-byte session content key, already unwrapped. */
  readonly contentKey: Uint8Array;
}

/** What the seal stage produces, carried to the embed stage. */
interface SealedContentPartition {
  readonly ciphertext: ContentPayloadCiphertext;
  /** PRE-truncation UTF-8 byte length of {@link EventContentInput.body}. */
  readonly contentLength: number;
  readonly truncated: boolean;
}

/**
 * The two `payload` members the SEALING CODEC owns and no producer may supply
 * — each determined at the seal step from the body actually sealed.
 *
 * `contentType` is deliberately absent: the producer knows the media type of
 * what it emitted, and this codec never could.
 */
const CODEC_OWNED_CONTENT_PAYLOAD_KEYS: readonly string[] = [
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
];

/**
 * Thrown when a producer pre-seeds a payload with a member the sealing codec
 * alone determines. Carries the offending KEY, never the value.
 */
export class CodecOwnedContentKeyError extends Error {
  readonly seededKey: string;

  constructor(refuser: string, seededKey: string) {
    super(
      `${refuser} refuses an event whose payload already carries ${seededKey}: this codec is the only producer of ${CODEC_OWNED_CONTENT_PAYLOAD_KEYS.join(", ")}, each determined at the seal step from the body it actually sealed. Pass the prose as content.body; contentType is the producer's member and is unaffected.`,
    );
    this.name = "CodecOwnedContentKeyError";
    this.seededKey = seededKey;
  }
}

/**
 * Refuse a payload that pre-seeds either member the sealing codec owns — ONE
 * definition, consumed at BOTH ends of the sole durable append path.
 *
 * `EventLogService.append` reaches the table by two branches: a plain append
 * that stores the caller's payload as given, and a sealing append that routes
 * through this codec. The guard runs once at the top of that path — ahead of the
 * branch choice — and once inside the codec, so a caller that omits
 * `options.content` cannot store a false length or truncation claim on the
 * plain branch, and a caller that invokes the codec directly is refused too.
 *
 * It runs on EVERY payload, registered type or not: it refuses a member, not a
 * type, so no envelope is dropped for being uninterpretable.
 *
 * The key is echoed; no payload VALUE ever reaches the message.
 */
export function assertNoCodecOwnedContentKeys(
  payload: Record<string, unknown>,
  refuser: string,
): void {
  const seededContentKey = CODEC_OWNED_CONTENT_PAYLOAD_KEYS.find((key) =>
    Object.hasOwn(payload, key),
  );
  if (seededContentKey !== undefined) {
    throw new CodecOwnedContentKeyError(refuser, seededContentKey);
  }
}

/**
 * Every `SessionEvent` variant whose registered payload declares the codec's
 * content-length member — DERIVED from the contracts union rather than listed,
 * so the closed set cannot disagree with the schemas.
 *
 * The conditional distributes over the union because `Variant` is a naked type
 * parameter; `keyof` includes OPTIONAL members, which is what makes the test
 * work, since every member of `MachineContentDescriptor` is optional.
 */
type EventTypeCarryingContentDescriptor<Variant> = Variant extends {
  type: infer VariantType;
  payload: infer VariantPayload;
}
  ? typeof CONTENT_LENGTH_PAYLOAD_KEY extends keyof VariantPayload
    ? VariantType
    : never
  : never;

/** The event types that may carry a machine-authored content partition. */
export type BodyBearingEventType = EventTypeCarryingContentDescriptor<SessionEvent>;

/**
 * The runtime half of the same closed set, and a BIDIRECTIONAL drift guard: a
 * variant that gains a content descriptor in contracts leaves a required key
 * missing here, and a key here that names no such variant is an excess property
 * on the literal. An object rather than a `Set`, so the annotation catches a
 * MISSING member as well as a wrong one.
 */
export const BODY_BEARING_EVENT_TYPES: Readonly<Record<BodyBearingEventType, true>> = {
  "assistant.message": true,
  "assistant.thinking_update": true,
  "tool.invoked": true,
  "tool.result": true,
  "tool.error": true,
  "approval.reviewer_denied": true,
};

/**
 * The event types with a registered `SessionEventSchema` payload variant —
 * derived from contracts' own `SESSION_EVENT_TYPES` roster, so it widens by
 * itself as variants land. Typed `ReadonlySet<string>` because the value tested
 * against it is `EventEnvelope.type`, the tolerant free-form carrier.
 */
const REGISTERED_STRICT_VARIANT_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_TYPES,
);

/** What the PII encrypt stage produces. */
interface SealedPiiPartition {
  readonly ciphertext: PiiPayloadCiphertext;
  readonly userId: string;
}

/**
 * The AEAD associated data the content partition binds, `session_id || event_id`:
 * a ciphertext sealed under this cannot be replayed onto another row or another
 * session. `session_id` is fixed-width UUID form (or the reserved daemon-scope
 * sentinel), so no length prefix is needed to keep two pairs from colliding.
 */
function buildContentSealAad(sessionId: string, eventId: string): Uint8Array {
  return new TextEncoder().encode(`${sessionId}${eventId}`);
}

/**
 * The UTF-8 width of one code point, from its scalar value alone. Total over
 * every UTF-16 unit value, including an unpaired surrogate (three bytes, what
 * `TextEncoder`'s U+FFFD substitution encodes to).
 */
function utf8ByteWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * The UTF-16 index of the first unpaired surrogate in `value`, or `-1` when the
 * string is well-formed. `String.prototype.isWellFormed()` answers only yes or
 * no, and the refusal message names an index.
 */
function findUnpairedSurrogateIndex(value: string): number {
  for (let unitIndex = 0; unitIndex < value.length; unitIndex += 1) {
    const unit = value.charCodeAt(unitIndex);
    if (unit < 0xd800 || unit > 0xdfff) {
      continue;
    }
    if (unit > 0xdbff) {
      return unitIndex;
    }
    const trailingUnit = unitIndex + 1 < value.length ? value.charCodeAt(unitIndex + 1) : -1;
    if (trailingUnit < 0xdc00 || trailingUnit > 0xdfff) {
      return unitIndex;
    }
    unitIndex += 1;
  }
  return -1;
}

/**
 * Applies the plaintext bound, cutting at a UTF-8 CODEPOINT boundary.
 *
 * ENCODES A BOUNDED PREFIX AND NEVER THE WHOLE BODY. A tool result is routinely
 * a file dump, so encoding first and cutting afterwards would allocate without
 * bound on exactly the input the ceiling exists to contain. The walk computes
 * the pre-truncation byte length in O(1) space, then encodes at most
 * {@link CONTENT_PAYLOAD_PLAINTEXT_MAX} bytes' worth of prefix: the longest
 * whole-code-point prefix whose UTF-8 length fits. A body that lands exactly on
 * the budget is not truncated.
 *
 * The caller has already refused an ill-formed body, so the surrogate-pair step
 * below only ever meets well-formed pairs.
 *
 * `contentLength` reports the PRE-truncation length, so the size of what was
 * dropped stays recoverable from the log.
 */
function applyPlaintextBound(body: string): {
  readonly bytes: Uint8Array;
  readonly contentLength: number;
  readonly truncated: boolean;
} {
  // `boundedUnitCount` is the UTF-16 length of the longest prefix that fits, and
  // `-1` means "nothing has crossed the budget yet".
  let contentLength = 0;
  let boundedUnitCount = -1;
  for (let unitIndex = 0; unitIndex < body.length; ) {
    const unit = body.charCodeAt(unitIndex);
    let unitWidth = 1;
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff && unitIndex + 1 < body.length) {
      const trailingUnit = body.charCodeAt(unitIndex + 1);
      if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff) {
        codePoint = (unit - 0xd800) * 0x400 + (trailingUnit - 0xdc00) + 0x10000;
        unitWidth = 2;
      }
    }
    const byteWidth = utf8ByteWidth(codePoint);
    if (boundedUnitCount < 0 && contentLength + byteWidth > CONTENT_PAYLOAD_PLAINTEXT_MAX) {
      boundedUnitCount = unitIndex;
    }
    contentLength += byteWidth;
    unitIndex += unitWidth;
  }

  if (boundedUnitCount < 0) {
    return { bytes: new TextEncoder().encode(body), contentLength, truncated: false };
  }
  return {
    bytes: new TextEncoder().encode(body.slice(0, boundedUnitCount)),
    contentLength,
    truncated: true,
  };
}

/**
 * Seals the bounded plaintext under the session content key. Local rather than
 * injected, unlike {@link PiiEncryptor}: the session content key has no per-user
 * custody question behind it and the wire format is fixed here.
 */
function sealContentPartition(
  content: EventContentInput,
  sessionId: string,
  eventId: string,
): SealedContentPartition {
  const bounded = applyPlaintextBound(content.body);
  const iv = new Uint8Array(randomBytes(CONTENT_SEAL_IV_BYTES));
  const cipher = createCipheriv("aes-256-gcm", content.contentKey, iv);
  cipher.setAAD(buildContentSealAad(sessionId, eventId));
  const body = Buffer.concat([cipher.update(bounded.bytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  const sealed = new Uint8Array(iv.length + body.length + tag.length);
  sealed.set(iv, 0);
  sealed.set(body, iv.length);
  sealed.set(tag, iv.length + body.length);
  return {
    ciphertext: sealed as ContentPayloadCiphertext,
    contentLength: bounded.contentLength,
    truncated: bounded.truncated,
  };
}

/**
 * Opens a stored `content_payload` — the read-side counterpart of
 * {@link sealContentPartition}, housed beside it so the envelope format has one
 * home.
 *
 * THROWS on any failure, and the caller classifies rather than propagates:
 * `content-read.ts` maps every throw here onto the closed
 * `HydratedContentUnavailableReason` union. A wrong key, a tampered tag and a
 * truncated blob are not distinguished — the AEAD itself does not distinguish
 * them.
 *
 * NEVER RETURNS A PARTIAL BODY. `decipher.final()` is what verifies the tag, so
 * reading `update()`'s output alone would hand back unauthenticated plaintext.
 */
export function openContentPayload(
  storedContentPayload: Uint8Array,
  contentKey: Uint8Array,
  sessionId: string,
  eventId: string,
): string {
  const floor = CONTENT_SEAL_IV_BYTES + CONTENT_SEAL_TAG_BYTES;
  if (storedContentPayload.length < floor) {
    throw new Error(
      `stored content_payload is ${String(storedContentPayload.length)} bytes, under the ${String(floor)}-byte iv+tag floor`,
    );
  }
  if (contentKey.length !== CONTENT_SEAL_KEY_BYTES) {
    throw new Error(
      `session content key is ${String(contentKey.length)} bytes, expected ${String(CONTENT_SEAL_KEY_BYTES)}`,
    );
  }
  const iv = storedContentPayload.subarray(0, CONTENT_SEAL_IV_BYTES);
  const tag = storedContentPayload.subarray(storedContentPayload.length - CONTENT_SEAL_TAG_BYTES);
  const body = storedContentPayload.subarray(
    CONTENT_SEAL_IV_BYTES,
    storedContentPayload.length - CONTENT_SEAL_TAG_BYTES,
  );
  const decipher = createDecipheriv("aes-256-gcm", contentKey, iv);
  decipher.setAAD(buildContentSealAad(sessionId, eventId));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  // `fatal: true` so an invalid sequence throws instead of decoding to U+FFFD.
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

// --------------------------------------------------------------------------
// The injected encryptor boundary.
// --------------------------------------------------------------------------

/**
 * One PII encryption request. The two identifier members are BOUND as the
 * AEAD's associated data (`user_id || event_id`), which is what makes a
 * ciphertext non-replayable onto another user or another event.
 */
export interface PiiEncryptionRequest {
  /**
   * The user whose content key encrypts this PII. Supplied explicitly rather
   * than derived from the envelope's `actor`, which may be an agent id or
   * `null` for a system event and so cannot name a key holder.
   */
  readonly userId: string;
  /** The `EventEnvelope.id` of the event this ciphertext belongs to. */
  readonly eventId: string;
  /**
   * The PII partition serialized to RFC 8785 canonical JSON, UTF-8 encoded —
   * the same serializer the canonical bytes use, which refuses `NaN` /
   * `Infinity` / a value with no JSON representation loudly where
   * `JSON.stringify` would emit `null` or nothing at all.
   */
  readonly plaintext: Uint8Array;
}

/**
 * The AEAD seam — declared here, injected at the composition root.
 *
 * Returns BARE bytes on purpose; see {@link PiiPayloadCiphertext}. The
 * implementation owns the wire format, the nonce, the AAD binding, and the
 * per-user key lookup; this module asserts nothing about the returned width,
 * since the interface does not fix an AEAD.
 */
export interface PiiEncryptor {
  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array>;
}

// --------------------------------------------------------------------------
// RawEventInput — discriminated union.
// --------------------------------------------------------------------------

/** The category that is never purged, and so never carries a partition. */
type PiiRefusedCategory = "event_maintenance";

/**
 * Every other category. Derived by `Exclude`, so a category added to contracts
 * is PII-eligible by default.
 */
export type PiiEligibleCategory = Exclude<EventCategory, PiiRefusedCategory>;

/**
 * The canonical envelope members every input carries, tracked against
 * `EventEnvelope` by `Omit` so a member added in contracts arrives here
 * automatically.
 *
 * `actor` is re-declared NARROWER than the envelope's `string | null | undefined`
 * — required and two-state — because `session_events.actor` collapses absent and
 * `null` onto one NULL column while the canonical bytes distinguish them.
 */
interface RawEventCommonFields extends Readonly<Omit<EventEnvelope, "category" | "actor">> {
  readonly actor: string | null;
}

/**
 * An event whose category may carry PII, together with the partition to encrypt.
 * `payload` and `piiPayload` are the two halves of the split the EMITTER runs.
 */
export interface PiiCarryingEventInput extends RawEventCommonFields {
  readonly category: PiiEligibleCategory;
  readonly piiUserId: string;
  readonly piiPayload: Record<string, unknown>;
  /**
   * OPTIONAL here, because a row may carry both partitions: an
   * `assistant.message` that quotes a user carries machine prose in
   * `content_payload` and the quoted user text in `pii_payload`.
   */
  readonly content?: EventContentInput;
}

/**
 * An event carrying MACHINE-authored prose and no user PII — the common case for
 * `assistant.*` and `tool.*` rows. `piiPayload?: never` is what makes
 * `input.piiPayload !== undefined` a real narrowing.
 */
export interface ContentOnlyEventInput extends RawEventCommonFields {
  readonly category: PiiEligibleCategory;
  readonly piiUserId?: never;
  readonly piiPayload?: never;
  readonly content: EventContentInput;
}

/**
 * An `event_maintenance` event — the arm that exists to be REFUSED. The members
 * are optional `never` rather than required `never` so a value of this arm can
 * be built and reach the runtime guard through the type.
 */
interface PiiRefusedEventInput extends RawEventCommonFields {
  readonly category: PiiRefusedCategory;
  readonly piiUserId?: never;
  readonly piiPayload?: never;
  readonly content?: never;
}

/** The codec's input — a discriminated union on `category`. */
export type RawEventInput = PiiCarryingEventInput | ContentOnlyEventInput | PiiRefusedEventInput;

/**
 * Everything the caller needs to persist one sealed row.
 *
 * PERSIST THESE AS A UNIT. `envelope` carries the normalized `occurredAt` and
 * the content description members; `piiPayload` and `contentPayload` are the two
 * sealed columns; `piiUserId` is the value for the `pii_user_id` column. A
 * re-seal would mint an unrelated ciphertext under a fresh nonce, so the caller
 * writes these bytes, never a second seal.
 */
export interface PiiEventWriteResult {
  readonly envelope: EventEnvelope;
  /**
   * The user whose content key sealed `piiPayload`, echoed from
   * {@link PiiEncryptionRequest.userId}, or `undefined` on a content-only row.
   *
   * NOTHING ELSE ON THE ROW RECOVERS IT. `actor` is a different value, and AEAD
   * associated data is authenticated, not transported, so `user_id` is an INPUT
   * to any decrypt rather than an output of it. The column is also what erasure
   * keys on.
   *
   * Declared `string | undefined` rather than optional so it stays in every
   * caller's destructuring surface.
   */
  readonly piiUserId: string | undefined;
  readonly piiPayload: PiiPayloadCiphertext | undefined;
  /** The sealed machine-authored body for `content_payload`, or `undefined`. */
  readonly contentPayload: ContentPayloadCiphertext | undefined;
  /**
   * Byte length of the RFC 8785 canonical form of `envelope`, measured here and
   * echoed out so the caller holds it to `EVENT_CANONICAL_BYTES_MAX` without
   * canonicalizing the envelope a second time. Measurable only after the seal,
   * because the content description members exist only downstream of it.
   */
  readonly canonicalByteLength: number;
}

/**
 * Seals the partitions one event carries — a user PII partition, a
 * machine-authored content partition, or BOTH — and returns everything the
 * append path persists.
 *
 * REFUSAL ORDER, fixed because the first to fire is the only one the caller
 * sees:
 *
 *   1. A STRUCTURAL DEFECT IN THE PARTITIONING: a refused category, then an
 *      input carrying NEITHER partition, then a HALF-PRESENT PII partition
 *      (`piiUserId` with no `piiPayload`), then a CONTENT partition on an event
 *      type outside {@link BODY_BEARING_EVENT_TYPES}.
 *   2. A `payload` that already claims a codec-owned content member.
 *   3. A `sequence` that is not a safe integer — the same check
 *      `canonicalizeEvent` runs, hoisted so the two paths answer alike.
 *   4. A non-canonical `occurredAt`, then the PII partition's own serialization
 *      refusals (`canonicalizeJson` over `piiPayload`).
 *   5. A `piiUserId` that is not a non-empty string.
 *   6. A malformed CONTENT partition — a non-string `content.body`, then a
 *      `content.contentKey` that is not 32 bytes, then a `content.body` that is
 *      not well-formed UTF-16.
 *   7. A composed envelope its own registered variant rejects. The one refusal
 *      that fires behind the encrypt: its subject — the envelope with the
 *      content members in place — does not exist until the seal has run.
 *
 * `input.payload`'s own RFC 8785 refusals and the encryptor-result shape guard
 * also fire behind the encrypt, for the same reason: their subjects do not
 * exist before it.
 */
export async function writeEventWithPii(
  input: RawEventInput,
  encryptor: PiiEncryptor,
): Promise<PiiEventWriteResult> {
  // A `switch` over the discriminant narrows `input` to the two sealable arms;
  // the comparison still runs at RUNTIME, which is the point for a category
  // that arrived across a serialization boundary.
  switch (input.category) {
    case "event_maintenance":
      throw new Error(
        `writeEventWithPii refuses category ${JSON.stringify(input.category)}: ` +
          "event_maintenance events are never purged, so their pii_payload and content_payload " +
          "are NULL by construction. Append this event through the plain append path instead.",
      );
  }

  // A codec whose job is sealing a partition was reached with nothing to seal:
  // the append was routed to the wrong path.
  if (input.piiPayload === undefined && input.content === undefined) {
    throw new Error(
      "writeEventWithPii refuses an event carrying neither a PII partition nor a content partition: this codec is the write path for pii_payload and content_payload, and a row with neither belongs on the plain append path. Pass piiPayload, content, or both.",
    );
  }

  // The narrowing below discriminates on `piiPayload` alone, so a value
  // carrying `piiUserId` with no `piiPayload` would read as content-only and
  // its user half would be dropped silently.
  if (input.piiUserId !== undefined && input.piiPayload === undefined) {
    throw new Error(
      "writeEventWithPii refuses an event carrying piiUserId with no piiPayload: the two " +
        "are halves of one partition, and admitting the pair would route the row as " +
        "content-only and drop the user half silently — sealed nowhere and attributed to " +
        "no one. Pass both, or neither.",
    );
  }

  // The content members land in `payload`, and every other type's registered
  // payload schema is `.strict()` and declares none of them, so the row would
  // fail its own schema on the way back out. `Object.hasOwn` so a `type` of
  // `"__proto__"` cannot borrow a prototype member and pass.
  if (input.content !== undefined && !Object.hasOwn(BODY_BEARING_EVENT_TYPES, input.type)) {
    throw new Error(
      `writeEventWithPii refuses a content partition on event type ${JSON.stringify(input.type)}: machine-authored prose is sealed only for ${Object.keys(BODY_BEARING_EVENT_TYPES).join(", ")}, the types whose registered payload declares the codec's content members. Any other type would be stored carrying members its own schema rejects. Append this event through the plain append path instead.`,
    );
  }

  const piiCarrying: PiiCarryingEventInput | undefined =
    input.piiPayload === undefined ? undefined : input;
  const contentInput: EventContentInput | undefined = input.content;

  assertNoCodecOwnedContentKeys(input.payload, "writeEventWithPii");

  if (!Number.isSafeInteger(input.sequence)) {
    throw new Error(
      `writeEventWithPii refuses sequence ${String(input.sequence)}: it is not a safe integer (|value| must be at most ${String(Number.MAX_SAFE_INTEGER)}, and it must be an integer), so distinct sequences would collapse onto one IEEE-754 double and two different events would carry the same replay key. Refused before the encrypt step so a rejected append spends no seal.`,
    );
  }

  // Normalized BEFORE encrypting, and captured so the returned envelope carries
  // the normalized string rather than the producer's raw spelling.
  const normalizedOccurredAt: string = normalizeOccurredAt(input.occurredAt);

  // The PII PLAINTEXT bytes; `canonicalizeJson`'s brand is widened away because
  // these are not a row's canonical bytes.
  const piiPlaintext: Uint8Array | undefined =
    piiCarrying === undefined ? undefined : canonicalizeJson(piiCarrying.piiPayload);

  // The key holder's id. An empty string names no key holder while satisfying
  // every `string` in the pipeline, and nothing downstream judges this value's
  // shape. Reachable only through a cast or an untyped boundary.
  if (
    piiCarrying !== undefined &&
    (typeof piiCarrying.piiUserId !== "string" || piiCarrying.piiUserId.length === 0)
  ) {
    throw new Error(
      "writeEventWithPii requires a non-empty piiUserId: it names the user whose content " +
        "key seals this row and is the row's owner stamp; received " +
        `${describeUserIdShape(piiCarrying.piiUserId)}. Refused before the encrypt step so ` +
        "a rejected append spends no seal; nothing downstream re-checks this value's shape.",
    );
  }

  // Both content members break the row silently if wrong: `TextEncoder`
  // stringifies a non-string body rather than refusing (`null` becomes "null"),
  // a wrong-width key would throw only after the PII seal is spent, and an
  // unpaired surrogate is SUBSTITUTED with U+FFFD, so the stored text would not
  // be what the producer wrote while every later check passed.
  if (contentInput !== undefined) {
    if (typeof contentInput.body !== "string") {
      throw new Error(
        `writeEventWithPii requires content.body to be a string — it is the machine-authored prose sealed into session_events.content_payload; received ${describeUserIdShape(contentInput.body)}. TextEncoder would stringify a non-string rather than refuse it; nothing downstream re-checks this shape.`,
      );
    }
    if (
      !(contentInput.contentKey instanceof Uint8Array) ||
      contentInput.contentKey.length !== CONTENT_SEAL_KEY_BYTES
    ) {
      throw new Error(
        `writeEventWithPii requires a ${CONTENT_SEAL_KEY_BYTES}-byte Uint8Array content.contentKey — the session content key from session-content-key-store.ts, already unwrapped; received ${describeByteShape(contentInput.contentKey)}. Refused before the encrypt step so a rejected append spends no seal on either partition.`,
      );
    }
    const unpairedSurrogateIndex = findUnpairedSurrogateIndex(contentInput.body);
    if (unpairedSurrogateIndex >= 0) {
      throw new Error(
        `writeEventWithPii requires content.body to be well-formed UTF-16; it carries an unpaired surrogate at UTF-16 index ${String(unpairedSurrogateIndex)}. TextEncoder substitutes U+FFFD rather than refusing, so the stored body would carry a replacement character in place of the producer's text, and every later check would pass. Refused before the encrypt step so a rejected append spends no seal on either partition.`,
      );
    }
  }

  // --- ENCRYPT (PII partition) ----------------------------------------------
  let piiPartition: SealedPiiPartition | undefined;
  if (piiCarrying !== undefined && piiPlaintext !== undefined) {
    const encryptorResult: Uint8Array = await encryptor.encrypt({
      userId: piiCarrying.piiUserId,
      eventId: input.id,
      plaintext: piiPlaintext,
    });

    // The declared `Uint8Array` is a claim about a value that crossed an
    // injection boundary. Empty is refused too — no AEAD emits a zero-length
    // output. Width is not checked: the interface fixes no AEAD.
    if (!(encryptorResult instanceof Uint8Array) || encryptorResult.length === 0) {
      throw new Error(
        `PiiEncryptor.encrypt must return non-empty Uint8Array ciphertext for the session_events.pii_payload column; received ${describeByteShape(encryptorResult)}. That is an injection bug, not a tampered row.`,
      );
    }

    // The one site where `PiiPayloadCiphertext` enters the type system, and it
    // brands an OWNED COPY: the interface says nothing about the lifetime of
    // the buffer behind it, so a conforming implementation may reuse a scratch
    // array. `new Uint8Array(...)`, not `.slice()`, because
    // `Buffer.prototype.slice` returns a view. After the shape guard, because
    // the constructor coerces where the guard refuses.
    const piiPayload: PiiPayloadCiphertext = new Uint8Array(
      encryptorResult,
    ) as PiiPayloadCiphertext;
    piiPartition = { ciphertext: piiPayload, userId: piiCarrying.piiUserId };
  }

  // --- BOUND, then SEAL (content partition) ---------------------------------
  // After the PII encrypt so a row carrying both partitions spends its nonces
  // in a fixed order, and after every refusal so neither is spent on a defect.
  const contentPartition: SealedContentPartition | undefined =
    contentInput === undefined
      ? undefined
      : sealContentPartition(contentInput, input.sessionId, input.id);

  const envelope: EventEnvelope = composeStoredEnvelope(
    input,
    normalizedOccurredAt,
    contentPartition,
  );

  assertRegisteredVariantParses(envelope, {
    name: "writeEventWithPii",
    timing:
      "Refused after the seal and before the row is written, which is the only window in which the stored form exists to be checked.",
  });

  return {
    canonicalByteLength: canonicalizeEvent(envelope).length,
    contentPayload: contentPartition?.ciphertext,
    envelope,
    piiUserId: piiPartition?.userId,
    piiPayload: piiPartition?.ciphertext,
  };
}

/**
 * Builds the envelope as it will be STORED: the caller's members, the
 * normalized `occurredAt`, and — on a content row — the content description
 * members added to a SHALLOW copy of `payload`.
 *
 * `contentTruncated` is written ONLY when the bound fired: absence is the
 * completeness signal.
 *
 * Envelope members are projected one at a time, never spread from `input`:
 * `input` carries `piiPayload`, which must never become an envelope member —
 * spreading would put the PII partition itself into `payload`. The mapped
 * annotation makes every envelope member required, so a member added in
 * contracts breaks this literal instead of silently vanishing.
 */
function composeStoredEnvelope(
  input: PiiCarryingEventInput | ContentOnlyEventInput,
  normalizedOccurredAt: string,
  contentPartition: SealedContentPartition | undefined,
): EventEnvelope {
  const payload: Record<string, unknown> = { ...input.payload };
  if (contentPartition !== undefined) {
    payload[CONTENT_LENGTH_PAYLOAD_KEY] = contentPartition.contentLength;
    if (contentPartition.truncated) {
      payload[CONTENT_TRUNCATED_PAYLOAD_KEY] = true;
    }
  }

  const storedMembers: { [MemberName in keyof EventEnvelope]-?: EventEnvelope[MemberName] } = {
    id: input.id,
    sessionId: input.sessionId,
    sequence: input.sequence,
    occurredAt: normalizedOccurredAt,
    category: input.category,
    type: input.type,
    actor: input.actor,
    payload,
    correlationId: input.correlationId,
    causationId: input.causationId,
    version: input.version,
  };
  return storedMembers;
}

/**
 * One issue from the strict layer's own parse result, read off `safeParse`'s
 * return type so a Zod major that renames an issue member breaks
 * {@link describeStrictLayerIssues} at `pnpm typecheck`.
 */
type StrictLayerParseIssue = Extract<
  ReturnType<typeof SessionEventSchema.safeParse>,
  { success: false }
>["error"]["issues"][number];

/**
 * How many parse issues a refusal message renders before eliding the rest. The
 * elided COUNT is still reported.
 */
const STRICT_LAYER_ISSUES_RENDERED_MAX = 5;

/**
 * Renders parse issues as PATHS AND CODES, never as values: a payload member is
 * where a user's or a model's words can sit, and Zod's own `message` quotes
 * received values for several issue codes. `unrecognized_keys` also carries
 * member NAMES, the same class of datum as the path.
 */
function describeStrictLayerIssues(issues: readonly StrictLayerParseIssue[]): string {
  const rendered: string[] = issues
    .slice(0, STRICT_LAYER_ISSUES_RENDERED_MAX)
    .map((issue: StrictLayerParseIssue) => {
      const memberPath =
        issue.path.length === 0
          ? "<envelope>"
          : issue.path.map((segment) => String(segment)).join(".");
      return issue.code === "unrecognized_keys"
        ? `${memberPath} (${issue.code}: ${issue.keys.join(", ")})`
        : `${memberPath} (${issue.code})`;
    });
  const elidedCount = issues.length - rendered.length;
  return elidedCount === 0
    ? rendered.join("; ")
    : `${rendered.join("; ")}; and ${String(elidedCount)} further issue(s)`;
}

/** Which seam is refusing, and where in its own order the refusal lands. */
export interface StrictLayerParseSeam {
  /** The function a reader would grep for, spelled as it is declared. */
  readonly name: string;
  /** One sentence placing the refusal in that seam's own order. */
  readonly timing: string;
}

/**
 * PARSE WHAT WILL BE STORED — the last check on any row before it is written,
 * on either of the append path's two branches. One definition, two callers: the
 * sealing codec above and `EventLogService.append`'s plain branch.
 *
 * It refuses a registered type under the WRONG category, or with a `payload`
 * that type's own registered schema rejects — a row that would otherwise fail
 * the strict layer on the way back out and be readable only as a stub.
 *
 * A TYPE WITH NO REGISTERED VARIANT IS SKIPPED. `packages/contracts/src/event.ts`
 * is explicit that a reader "MUST persist an envelope whose `type` it cannot
 * interpret as a version stub — never drop or reject it", so refusing an
 * unregistered type would reject exactly the envelopes the stub path exists to
 * preserve.
 *
 * It does not cover the purge, which replaces a row's `payload` with the audit
 * stub projection — deliberately not its type's registered variant shape.
 */
export function assertRegisteredVariantParses(
  envelope: EventEnvelope,
  seam: StrictLayerParseSeam,
): void {
  if (!REGISTERED_STRICT_VARIANT_EVENT_TYPES.has(envelope.type)) {
    return;
  }

  const parsed = SessionEventSchema.safeParse(envelope);
  if (parsed.success) {
    return;
  }

  throw new Error(
    `${seam.name} refuses to store an event of type ${JSON.stringify(envelope.type)} that its own registered SessionEventSchema variant rejects: ${describeStrictLayerIssues(parsed.error.issues)}. Storing it would write a row that fails the strict layer on the way back out — permanently unreadable as anything but a stub. ${seam.timing}`,
  );
}

/**
 * Renders a refused byte-shaped value without trusting its declared type —
 * `value.length` on a `string` would report a character count as a byte count.
 */
function describeByteShape(value: unknown): string {
  if (value instanceof Uint8Array) {
    return value.length === 0 ? "an empty Uint8Array" : `${value.length} bytes`;
  }
  return `a non-Uint8Array value of type ${typeof value}`;
}

/**
 * Renders a refused string-shaped value as a type plus a character count, never
 * the value itself: that is the whole of what a reader can act on.
 */
function describeUserIdShape(value: unknown): string {
  if (typeof value === "string") {
    return value.length === 0 ? "an empty string" : `a ${value.length}-character string`;
  }
  return `a non-string value of type ${typeof value}`;
}
