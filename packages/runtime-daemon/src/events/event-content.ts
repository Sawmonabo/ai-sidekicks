// The content partition of an append: machine-authored prose kept in
// `session_events.content_payload` beside the event, with the description members it adds to
// `payload`, and the two checks both append branches run on the envelope about to be stored.
// `EventLogService` writes the row; this module touches no database.
import type { EventEnvelope, SessionEvent } from "@ai-sidekicks/contracts";
import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
} from "@ai-sidekicks/contracts";

import { findUnpairedSurrogateIndex } from "./canonicalizer.js";

/** The `payload` members only this module may set; `contentType` is the producer's. */
const CONTENT_DESCRIPTION_PAYLOAD_KEYS: readonly string[] = [
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
];

/** Thrown when a producer pre-seeds a content description member; carries the key only. */
class ContentDescriptionSeededError extends Error {
  readonly seededKey: string;

  constructor(refuser: string, seededKey: string) {
    super(
      `${refuser} refuses an event whose payload already carries ${seededKey}: the append path is the only producer of ${CONTENT_DESCRIPTION_PAYLOAD_KEYS.join(", ")}, each measured from the body it actually stores. Pass the prose as content.body; contentType is the producer's member and is unaffected.`,
    );
    this.name = "ContentDescriptionSeededError";
    this.seededKey = seededKey;
  }
}

/**
 * Throws when the payload pre-seeds a content description member, so a false length or
 * truncation claim cannot be stored on either append path.
 */
export function assertNoSeededContentDescription(
  payload: Record<string, unknown>,
  refuser: string,
): void {
  const seededContentKey = CONTENT_DESCRIPTION_PAYLOAD_KEYS.find((key) =>
    Object.hasOwn(payload, key),
  );
  if (seededContentKey !== undefined) {
    throw new ContentDescriptionSeededError(refuser, seededContentKey);
  }
}

// The `SessionEvent` variants whose payload declares the content-length member, derived from the
// contracts union. `keyof` includes optional members, so an optional content-length member counts.
type EventTypeCarryingContentDescriptor<Variant> = Variant extends {
  type: infer VariantType;
  payload: infer VariantPayload;
}
  ? typeof CONTENT_LENGTH_PAYLOAD_KEY extends keyof VariantPayload
    ? VariantType
    : never
  : never;

/** The event types that may carry a machine-authored content partition. */
type BodyBearingEventType = EventTypeCarryingContentDescriptor<SessionEvent>;

/**
 * The runtime half of the same set, a full record so the compiler flags a missing or excess key.
 */
const BODY_BEARING_EVENT_TYPES: Readonly<Record<BodyBearingEventType, true>> = {
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

// An unpaired surrogate counts three bytes, matching `TextEncoder`'s U+FFFD substitution.
function utf8ByteWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Cuts the body at the stored bound on a code point boundary and reports its whole UTF-8 length.
 * It walks the string once and slices it, since a tool result can be a huge file dump.
 */
function applyStoredBound(body: string): {
  readonly stored: string;
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
    return { stored: body, contentLength, truncated: false };
  }
  return { stored: body.slice(0, boundedUnitCount), contentLength, truncated: true };
}

/** One content-bearing row as stored: the envelope with its description members, and the body. */
export interface ComposedContentRow {
  readonly envelope: EventEnvelope;
  /** The text `content_payload` holds: the body, or its prefix when the bound fired. */
  readonly storedBody: string;
}

/**
 * Composes the stored form of an event that carries machine-authored prose. A body over
 * `CONTENT_PAYLOAD_PLAINTEXT_MAX` is truncated at a code point boundary, not refused, since
 * refusing would drop the turn. Throws a plain `Error` on a type that declares no content members
 * or a body that is not well-formed UTF-16.
 */
export function composeContentRow(envelope: EventEnvelope, body: string): ComposedContentRow {
  // `Object.hasOwn` stops a `type` of `"__proto__"` borrowing a prototype member.
  if (!Object.hasOwn(BODY_BEARING_EVENT_TYPES, envelope.type)) {
    throw new Error(
      `refuses a content partition on event type ${JSON.stringify(envelope.type)}: machine-authored prose is kept only for ${Object.keys(BODY_BEARING_EVENT_TYPES).join(", ")}, the types whose registered payload declares the content members. Any other type would be stored carrying members its own schema rejects.`,
    );
  }
  // SQLite stores TEXT as UTF-8, which would replace an unpaired surrogate with U+FFFD and keep
  // a body the producer never wrote.
  const unpairedSurrogateIndex = findUnpairedSurrogateIndex(body);
  if (unpairedSurrogateIndex >= 0) {
    throw new Error(
      `refuses a content body that is not well-formed UTF-16: it carries an unpaired surrogate at UTF-16 index ${String(unpairedSurrogateIndex)}.`,
    );
  }

  const bounded = applyStoredBound(body);
  const payload: Record<string, unknown> = { ...envelope.payload };
  payload[CONTENT_LENGTH_PAYLOAD_KEY] = bounded.contentLength;
  if (bounded.truncated) {
    payload[CONTENT_TRUNCATED_PAYLOAD_KEY] = true;
  }
  return { envelope: { ...envelope, payload }, storedBody: bounded.stored };
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

/**
 * Throws unless the envelope about to be stored parses against its registered `SessionEventSchema`
 * variant. It is the last check on both append branches; a type with no registered variant is
 * skipped (a reader must persist an unknown type as a version stub, never reject it).
 */
export function assertRegisteredVariantParses(envelope: EventEnvelope, refuser: string): void {
  if (!REGISTERED_STRICT_VARIANT_EVENT_TYPES.has(envelope.type)) {
    return;
  }

  const parsed = SessionEventSchema.safeParse(envelope);
  if (parsed.success) {
    return;
  }

  throw new Error(
    `${refuser} refuses to store an event of type ${JSON.stringify(envelope.type)} that its own registered SessionEventSchema variant rejects: ${describeStrictLayerIssues(parsed.error.issues)}. Storing it would write a row that fails the strict layer on the way back out, permanently unreadable as anything but a stub.`,
  );
}
