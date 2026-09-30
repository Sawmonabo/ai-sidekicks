// PII indirection codec: the only producer of non-null `session_events.pii_payload` and
// `session_events.content_payload` bytes. It seals user PII under the user's content key and
// machine-authored prose under the session content key, adds the content description members to
// `payload`, checks the composed envelope against its registered variant and measures its
// canonical size. `EventLogService` writes the row; this module touches no database.
//
// - The ciphertext brands are minted here only, so a non-null `PiiPayloadCiphertext` can come only
//   from code that ran this codec.
// - An `event_maintenance` event is never purged, so both columns are NULL by construction:
//   `RawEventInput` makes attaching one a compile error and `writeEventWithPii` refuses it at
//   runtime, for values that crossed a serialization boundary or an `as` cast.
// - Refusals decidable from the input alone come before the encrypt step: AES-256-GCM spends a
//   fresh random nonce per write, so a rejected append must not spend a seal.
// - Refusals throw a plain `Error`: no caller needs to tell them apart.
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

/**
 * The encrypted bytes for `session_events.pii_payload`, branded only in {@link writeEventWithPii}.
 * `PiiEncryptor` returns a bare `Uint8Array` so its implementation cannot mint the brand.
 */
export type PiiPayloadCiphertext = Uint8Array & { readonly __brand: "PiiPayloadCiphertext" };

/** The sealed body as stored: `iv || ciphertext || tag`, with AAD `session_id || event_id`. */
type ContentPayloadCiphertext = Uint8Array & {
  readonly __brand: "ContentPayloadCiphertext";
};

const CONTENT_SEAL_IV_BYTES = 12;

const CONTENT_SEAL_TAG_BYTES = 16;

const CONTENT_SEAL_KEY_BYTES = 32;

/**
 * The machine-authored body to seal and the key to seal it under. The key arrives already
 * unwrapped because resolving it can block on a person.
 */
export interface EventContentInput {
  /**
   * The machine-authored prose. A body over {@link CONTENT_PAYLOAD_PLAINTEXT_MAX} is truncated at a
   * code point boundary, not refused: refusing would drop the turn.
   */
  readonly body: string;
  /** The 32-byte session content key, already unwrapped. */
  readonly contentKey: Uint8Array;
}

interface SealedContentPartition {
  readonly ciphertext: ContentPayloadCiphertext;
  /** Pre-truncation UTF-8 byte length of {@link EventContentInput.body}. */
  readonly contentLength: number;
  readonly truncated: boolean;
}

/** The `payload` members only the sealing codec may set; `contentType` is the producer's. */
const CODEC_OWNED_CONTENT_PAYLOAD_KEYS: readonly string[] = [
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
];

/** Thrown when a producer pre-seeds a codec-owned payload member; carries the key only. */
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
 * Throws {@link CodecOwnedContentKeyError} when the payload pre-seeds a codec-owned member, so a
 * false length or truncation claim cannot be stored on either append path.
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

// The `SessionEvent` variants whose payload declares the content-length member, derived from the
// contracts union. `keyof` includes optional members, which the test needs.
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
 * The runtime half of the same set, a full record so the compiler flags a missing or excess key.
 */
export const BODY_BEARING_EVENT_TYPES: Readonly<Record<BodyBearingEventType, true>> = {
  "assistant.message": true,
  "assistant.thinking_update": true,
  "tool.invoked": true,
  "tool.result": true,
  "tool.error": true,
  "approval.reviewer_denied": true,
};

// A `ReadonlySet<string>` because it is tested against `EventEnvelope.type`, a free-form string.
const REGISTERED_STRICT_VARIANT_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_TYPES,
);

interface SealedPiiPartition {
  readonly ciphertext: PiiPayloadCiphertext;
  readonly userId: string;
}

// Binds the ciphertext to its row. Both ids are fixed-width, so no length prefix is needed.
function buildContentSealAad(sessionId: string, eventId: string): Uint8Array {
  return new TextEncoder().encode(`${sessionId}${eventId}`);
}

// An unpaired surrogate counts three bytes, matching `TextEncoder`'s U+FFFD substitution.
function utf8ByteWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

// Returns an index because the refusal names it; `isWellFormed()` only answers yes or no.
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
 * Cuts the body at the plaintext bound on a code point boundary and reports its pre-truncation
 * UTF-8 length. It encodes only the bounded prefix, since a tool result can be a huge file dump.
 */
function applyPlaintextBound(body: string): {
  readonly bytes: Uint8Array;
  readonly contentLength: number;
  readonly truncated: boolean;
} {
  // The UTF-16 length of the longest prefix that fits; `-1` until the budget is crossed.
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
 * Opens a stored `content_payload`. Throws on any failure (wrong key, tampered tag, truncated
 * blob) and never returns a partial body; `content-read.ts` maps every throw to an unavailable
 * reason.
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

/** One PII encryption request; `userId` and `eventId` are bound as the AEAD's associated data. */
export interface PiiEncryptionRequest {
  /** The user whose content key encrypts this PII; the envelope's `actor` cannot name one. */
  readonly userId: string;
  /** The `EventEnvelope.id` of the event this ciphertext belongs to. */
  readonly eventId: string;
  /** The PII partition as RFC 8785 canonical JSON, UTF-8 encoded. */
  readonly plaintext: Uint8Array;
}

/**
 * The AEAD seam. It owns the wire format, nonce, AAD binding and per-user key lookup, and returns
 * bare bytes (see {@link PiiPayloadCiphertext}); this module checks no width.
 */
export interface PiiEncryptor {
  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array>;
}

type PiiRefusedCategory = "event_maintenance";

/** Every category except `event_maintenance`; a new category is eligible by default. */
export type PiiEligibleCategory = Exclude<EventCategory, PiiRefusedCategory>;

// `actor` is required because `session_events.actor` stores absent and `null` as one NULL while
// the canonical bytes distinguish them.
interface RawEventCommonFields extends Readonly<Omit<EventEnvelope, "category" | "actor">> {
  readonly actor: string | null;
}

/** An event whose category may carry PII, with the partition to encrypt. */
export interface PiiCarryingEventInput extends RawEventCommonFields {
  readonly category: PiiEligibleCategory;
  readonly piiUserId: string;
  readonly piiPayload: Record<string, unknown>;
  /** Optional because a row may carry both partitions, as when an assistant quotes a user. */
  readonly content?: EventContentInput;
}

/** An event carrying machine-authored prose and no user PII. */
export interface ContentOnlyEventInput extends RawEventCommonFields {
  readonly category: PiiEligibleCategory;
  readonly piiUserId?: never;
  readonly piiPayload?: never;
  readonly content: EventContentInput;
}

// The arm that exists to be refused; its `never` members let a value reach the runtime guard.
interface PiiRefusedEventInput extends RawEventCommonFields {
  readonly category: PiiRefusedCategory;
  readonly piiUserId?: never;
  readonly piiPayload?: never;
  readonly content?: never;
}

/** The codec's input, a discriminated union on `category`. */
export type RawEventInput = PiiCarryingEventInput | ContentOnlyEventInput | PiiRefusedEventInput;

/**
 * Everything the caller persists for one sealed row. The caller writes these bytes and never
 * reseals: a second seal yields an unrelated ciphertext under a fresh nonce.
 */
export interface PiiEventWriteResult {
  readonly envelope: EventEnvelope;
  /**
   * The user whose content key sealed `piiPayload`, for `pii_user_id`; `undefined` on a
   * content-only row. Erasure keys on it and nothing else on the row recovers it.
   */
  readonly piiUserId: string | undefined;
  readonly piiPayload: PiiPayloadCiphertext | undefined;
  readonly contentPayload: ContentPayloadCiphertext | undefined;
  /** Canonical byte length of `envelope`, for the `EVENT_CANONICAL_BYTES_MAX` check. */
  readonly canonicalByteLength: number;
}

/**
 * Seals the partitions one event carries (user PII, machine-authored content, or both) and
 * returns what the append path persists. Throws a plain `Error` on a refusal; every refusal that
 * needs only the input comes before the encrypt, the rest after it.
 */
export async function writeEventWithPii(
  input: RawEventInput,
  encryptor: PiiEncryptor,
): Promise<PiiEventWriteResult> {
  switch (input.category) {
    case "event_maintenance":
      throw new Error(
        `writeEventWithPii refuses category ${JSON.stringify(input.category)}: ` +
          "event_maintenance events are never purged, so their pii_payload and content_payload " +
          "are NULL by construction. Append this event through the plain append path instead.",
      );
  }

  if (input.piiPayload === undefined && input.content === undefined) {
    throw new Error(
      "writeEventWithPii refuses an event carrying neither a PII partition nor a content partition: this codec is the write path for pii_payload and content_payload, and a row with neither belongs on the plain append path. Pass piiPayload, content, or both.",
    );
  }

  // Later code narrows on `piiPayload` alone, so a lone `piiUserId` would be silently dropped.
  if (input.piiUserId !== undefined && input.piiPayload === undefined) {
    throw new Error(
      "writeEventWithPii refuses an event carrying piiUserId with no piiPayload: the two " +
        "are halves of one partition, and admitting the pair would route the row as " +
        "content-only and drop the user half silently — sealed nowhere and attributed to " +
        "no one. Pass both, or neither.",
    );
  }

  // Other types' strict schemas declare no content members. `Object.hasOwn` stops a `type` of
  // `"__proto__"` borrowing a prototype member.
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

  const normalizedOccurredAt: string = normalizeOccurredAt(input.occurredAt);

  const piiPlaintext: Uint8Array | undefined =
    piiCarrying === undefined ? undefined : canonicalizeJson(piiCarrying.piiPayload);

  // An empty id names no key holder yet satisfies `string`; reachable only through a cast.
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

  // Wrong content members corrupt silently: `TextEncoder` stringifies a non-string body, a
  // wrong-width key throws only after the PII seal is spent, and an unpaired surrogate becomes
  // U+FFFD.
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

  let piiPartition: SealedPiiPartition | undefined;
  if (piiCarrying !== undefined && piiPlaintext !== undefined) {
    const encryptorResult: Uint8Array = await encryptor.encrypt({
      userId: piiCarrying.piiUserId,
      eventId: input.id,
      plaintext: piiPlaintext,
    });

    // The value crossed an injection boundary. Empty is refused because no AEAD emits zero bytes.
    if (!(encryptorResult instanceof Uint8Array) || encryptorResult.length === 0) {
      throw new Error(
        `PiiEncryptor.encrypt must return non-empty Uint8Array ciphertext for the session_events.pii_payload column; received ${describeByteShape(encryptorResult)}. That is an injection bug, not a tampered row.`,
      );
    }

    // The only site that mints `PiiPayloadCiphertext`. It brands an owned copy because an
    // implementation may reuse a scratch buffer; `.slice()` on a `Buffer` returns a view.
    const piiPayload: PiiPayloadCiphertext = new Uint8Array(
      encryptorResult,
    ) as PiiPayloadCiphertext;
    piiPartition = { ciphertext: piiPayload, userId: piiCarrying.piiUserId };
  }

  // After every refusal, so no nonce is spent on a defect.
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
 * Builds the envelope as stored. `contentTruncated` is written only when the bound fired. Members
 * are projected one at a time because spreading `input` would put `piiPayload` into the envelope.
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

type StrictLayerParseIssue = Extract<
  ReturnType<typeof SessionEventSchema.safeParse>,
  { success: false }
>["error"]["issues"][number];

const STRICT_LAYER_ISSUES_RENDERED_MAX = 5;

// Renders paths and codes, never values: a payload can hold a user's words and Zod's `message`
// quotes received values.
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
  readonly name: string;
  readonly timing: string;
}

/**
 * Throws unless the envelope about to be stored parses against its registered `SessionEventSchema`
 * variant. It is the last check on both append branches; a type with no registered variant is
 * skipped, and the purge's stub projection is deliberately not covered.
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

// Does not trust the declared type: `.length` on a `string` would report characters as bytes.
function describeByteShape(value: unknown): string {
  if (value instanceof Uint8Array) {
    return value.length === 0 ? "an empty Uint8Array" : `${value.length} bytes`;
  }
  return `a non-Uint8Array value of type ${typeof value}`;
}

function describeUserIdShape(value: unknown): string {
  if (typeof value === "string") {
    return value.length === 0 ? "an empty string" : `a ${value.length}-character string`;
  }
  return `a non-string value of type ${typeof value}`;
}
