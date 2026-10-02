// RFC 8785 JSON Canonicalization Scheme (JCS): the single source of canonical bytes.
//
// Every serializer goes through `canonicalizeJson` / `canonicalizeEvent`, so two implementations
// never disagree on one value.
// `canonicalizeJson` refuses excess nesting, a callable `toJSON` and an unpaired surrogate;
// `canonicalizeEvent` also refuses an unsafe-integer `sequence`.
// The `canonicalize` serializer is pinned exactly so a bump cannot change output bytes; the
// golden-vector suite binds it to RFC 8785 Appendix B, Table 1. Its bare errors (`NaN is not
// allowed`, `Infinity is not allowed`, `Circular reference detected`) can still surface.

import type { EventEnvelope } from "@ai-sidekicks/contracts";
import canonicalize from "canonicalize";

const utf8Encoder = new TextEncoder();

/** The UTF-8 bytes of an RFC 8785 canonicalization; only this module can construct one. */
export type CanonicalBytes = Uint8Array & { readonly __brand: "CanonicalBytes" };

// The stored `occurredAt` is RFC 3339 UTC at millisecond precision, matching the `occurred_at`
// column in `session/daemon-schema.ts`. A wider wire form (optional seconds, longer fractions,
// `±HH:MM` offsets) is normalized only when that preserves the instant; otherwise it is refused.
// Parsing is component-wise, never `Date.parse`, whose engine leniency must not decide a stored
// value; the instant uses `setUTCFullYear` because `Date.UTC` maps years 0-99 to 1900 + year.

/** The canonical form — the only shape `normalizeOccurredAt` ever returns. */
const CANONICAL_OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The wire schema's `z.iso.datetime({ offset: true })` shape without calendar checks (the read-back
// below does those). Groups: 1 year, 2 month, 3 day, 4 hour, 5 minute, 6 second?, 7 fraction?,
// then `Z` or an offset giving 8 sign, 9 hours, 10 minutes.
const CANONICALIZABLE_OCCURRED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/;

/**
 * Normalizes an `occurredAt` to `YYYY-MM-DDTHH:MM:SS.sssZ`; throws for a bad shape, sub-millisecond
 * precision, a non-existent date or an offset fold outside four-digit years.
 */
export function normalizeOccurredAt(occurredAt: string): string {
  const match = CANONICALIZABLE_OCCURRED_AT_PATTERN.exec(occurredAt);
  if (match === null) {
    throw new Error(
      `EventEnvelope.occurredAt must be an RFC 3339 date-time with an uppercase T separator and a Z or ±HH:MM offset received ${JSON.stringify(occurredAt)}.`,
    );
  }

  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const hour = Number(match[4]!);
  const minute = Number(match[5]!);
  const second = Number(match[6] ?? "0");
  const fractionalDigits = match[7] ?? "";

  // Trailing zeros past the third digit are notation; any other digit is refused, not truncated.
  if (/[1-9]/.test(fractionalDigits.slice(3))) {
    throw new Error(
      `EventEnvelope.occurredAt carries sub-millisecond precision (${JSON.stringify(occurredAt)}), which the canonical form YYYY-MM-DDTHH:MM:SS.sssZ cannot represent. Truncating it here would store a different instant than the one recorded, so the producer must emit millisecond precision.`,
    );
  }
  const millisecond = Number(fractionalDigits.padEnd(3, "0").slice(0, 3));

  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, millisecond);

  // The setters roll an invalid date over (February 30), so this read-back is the calendar check.
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  ) {
    throw new Error(
      `EventEnvelope.occurredAt names a date that does not exist on the calendar: ${JSON.stringify(occurredAt)}.`,
    );
  }

  // `-00:00` is accepted: it marks an unknown local offset and is the same instant as `+00:00`.
  // With a sign, groups 9 and 10 are guaranteed, so they take `!` rather than a `?? "0"` that
  // would silently fold an offset to zero.
  const offsetSign = match[8];
  const offsetMilliseconds =
    offsetSign === undefined
      ? 0
      : (offsetSign === "-" ? -1 : 1) * (Number(match[9]!) * 60 + Number(match[10]!)) * 60_000;

  const normalized = new Date(instant.getTime() - offsetMilliseconds).toISOString();
  if (!CANONICAL_OCCURRED_AT_PATTERN.test(normalized)) {
    // The fold lands outside the four-digit years `toISOString()` renders
    // (`0000-01-01T00:00:00+05:00` folds to year -1, `9999-12-31T23:59:59-05:00` to year 10000).
    throw new Error(
      `EventEnvelope.occurredAt does not fold into the canonical form YYYY-MM-DDTHH:MM:SS.sssZ: ${JSON.stringify(occurredAt)} normalizes to ${JSON.stringify(normalized)}.`,
    );
  }
  return normalized;
}

/**
 * The deepest container nesting {@link canonicalizeJson} serializes (`{}` is depth 1). The library
 * walks iteratively, so this is not a stack bound: the two guards after the depth walk have no
 * cycle detection, and this ceiling is what turns a cycle into a refusal instead of a hang.
 */
const CANONICAL_JSON_MAX_DEPTH = 64;

/**
 * Refuses a value nested deeper than {@link CANONICAL_JSON_MAX_DEPTH}, iteratively so the check
 * cannot overflow the stack itself. It ignores `toJSON`; {@link assertNoToJsonOverride} runs right
 * after and closes that. A cycle is reported as depth exhaustion.
 */
function assertWithinCanonicalDepth(value: unknown): void {
  const pending: Array<{ readonly node: unknown; readonly depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (entry.node === null || typeof entry.node !== "object") continue;
    if (entry.depth > CANONICAL_JSON_MAX_DEPTH) {
      throw new Error(
        `RFC 8785 canonicalization refused: the value nests containers deeper than ${CANONICAL_JSON_MAX_DEPTH} levels. The guards after this one have no cycle detection, so an unbounded or cyclic value would stall this entry point, which handles untrusted request bodies.`,
      );
    }
    for (const childValue of Object.values(entry.node as Record<string, unknown>)) {
      if (childValue !== null && typeof childValue === "object") {
        pending.push({ node: childValue, depth: entry.depth + 1 });
      }
    }
  }
}

/**
 * Refuses any value carrying a callable `toJSON`, at any depth. The library serializes the result
 * of `toJSON` instead of the value, which evades the other guards and breaks determinism (a
 * counting `toJSON` yields different bytes each call). Runs after the depth guard, which it relies
 * on for cycles, and before {@link assertWellFormedStrings}. The message reports depth, never a
 * property path, because property names are caller data that would reach logs.
 */
function assertNoToJsonOverride(value: unknown): void {
  const pending: Array<{ readonly node: object; readonly containersAbove: number }> = [];
  if (value !== null && typeof value === "object") {
    pending.push({ node: value, containersAbove: 0 });
  }
  while (pending.length > 0) {
    const entry = pending.pop()!;
    // The library's own prototype-chain read: `Object.hasOwn` would wave `Date` through.
    if (typeof (entry.node as { readonly toJSON?: unknown }).toJSON === "function") {
      throw new Error(
        `RFC 8785 canonicalization refused: ${
          entry.containersAbove === 0
            ? "the top-level value"
            : `a value nested ${String(entry.containersAbove)} containers deep`
        } carries a callable toJSON, which the serializer invokes and serializes INSTEAD of the value — so the canonical bytes would come from a tree none of this module's guards inspected, and a stateful toJSON makes two canonicalizations of one value produce DIFFERENT bytes, which no consumer re-canonicalizing the value can reproduce. Apply the conversion explicitly and pass the converted plain-JSON value instead. The property path is withheld: this entry point also canonicalizes PII plaintext.`,
      );
    }
    for (const childValue of Object.values(entry.node as Record<string, unknown>)) {
      if (childValue !== null && typeof childValue === "object") {
        pending.push({ node: childValue, containersAbove: entry.containersAbove + 1 });
      }
    }
  }
}

/** Matches the first unpaired UTF-16 surrogate; not `u`-flagged, because it works on code units. */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The UTF-16 index of the first unpaired surrogate in `text`, or -1 when it is well-formed. An
 * index, because a refusal names it; `isWellFormed()` only answers yes or no.
 */
export function findUnpairedSurrogateIndex(text: string): number {
  return LONE_SURROGATE_PATTERN.exec(text)?.index ?? -1;
}

/**
 * Refuses an unpaired surrogate without quoting the text, which may be PII headed for logs. The
 * library refuses one too, but its message names neither the position nor the code unit.
 */
function assertNoLoneSurrogate(text: string, positionDescription: string): void {
  const unpairedIndex = findUnpairedSurrogateIndex(text);
  if (unpairedIndex === -1) return;
  const codeUnit = text.charCodeAt(unpairedIndex);
  throw new Error(
    `RFC 8785 canonicalization refused: ${positionDescription} carries an unpaired UTF-16 surrogate (U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")}) at index ${String(unpairedIndex)}. RFC 8785 section 3.2.2.2 requires a compliant JCS implementation to terminate on lone surrogates. The string itself is withheld: this entry point also canonicalizes PII plaintext.`,
  );
}

/**
 * Refuses any value carrying an unpaired surrogate in a string or property name, at any depth
 * (RFC 8785 covers property names too). Runs after the depth guard: it has no cycle detection.
 */
function assertWellFormedStrings(value: unknown): void {
  if (typeof value === "string") {
    assertNoLoneSurrogate(value, "the top-level string");
    return;
  }
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node === null || typeof node !== "object") continue;
    // Array indices cannot hold a surrogate, so arrays skip the name check.
    const isArray = Array.isArray(node);
    for (const [memberName, memberValue] of Object.entries(node as Record<string, unknown>)) {
      if (!isArray) assertNoLoneSurrogate(memberName, "a property name");
      if (typeof memberValue === "string") {
        assertNoLoneSurrogate(memberValue, "a string value");
      } else if (memberValue !== null && typeof memberValue === "object") {
        pending.push(memberValue);
      }
    }
  }
}

/**
 * Canonicalizes an arbitrary JSON value to RFC 8785 bytes. Guards run in a fixed order and the
 * first to fire is the only one reported: depth, then `toJSON`, then well-formedness.
 */
export function canonicalizeJson(value: unknown): CanonicalBytes {
  assertWithinCanonicalDepth(value);
  assertNoToJsonOverride(value);
  assertWellFormedStrings(value);
  const canonicalText = canonicalize(value);
  if (typeof canonicalText !== "string") {
    // A top-level `undefined`, function or symbol yields no output, and
    // `TextEncoder.encode(undefined)` would return zero bytes for it.
    throw new Error(
      "RFC 8785 canonicalization produced no output: the value has no JSON representation (undefined, a function, or a symbol).",
    );
  }
  const canonicalUtf8Bytes: Uint8Array = utf8Encoder.encode(canonicalText);
  return canonicalUtf8Bytes as CanonicalBytes;
}

/**
 * Refuses an envelope `sequence` that is not a safe integer: past 2^53 - 1 distinct sequences
 * collapse to one double and would share one replay key. Lives here, not in `canonicalizeJson`,
 * because RFC 8785 mandates output for unsafe payload numbers. It checks `Number.isSafeInteger`,
 * the property the bytes need, rather than importing `EVENT_ENVELOPE_SEQUENCE_MAX`: a shared
 * import would make the two agree even on a wrong value.
 */
function assertRepresentableSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence)) {
    throw new Error(
      `RFC 8785 canonicalization refused: sequence ${String(sequence)} is not a safe integer (|value| must be at most ${String(Number.MAX_SAFE_INTEGER)}, and it must be an integer). Outside that range distinct sequences collapse onto the same IEEE-754 double, so two different events would produce identical canonical bytes and share one replay key.`,
    );
  }
}

/**
 * Canonicalizes an {@link EventEnvelope} to its RFC 8785 bytes, which the append path computes
 * before every write. `actor` must already have the shape the row stores (absent and
 * `null` emit different bytes); that narrowing belongs to `EventLogService.append`.
 */
export function canonicalizeEvent(envelope: EventEnvelope): CanonicalBytes {
  // An in-process envelope literal may never have met the wire schema, so check first.
  assertRepresentableSequence(envelope.sequence);

  // The mapped annotation is the drift guard: `-?` makes a twelfth envelope member fail to compile
  // instead of vanishing from the bytes, and `EventEnvelope[MemberName]` catches a cross-wired one.
  const canonicalMembers: { [MemberName in keyof EventEnvelope]-?: EventEnvelope[MemberName] } = {
    id: envelope.id,
    sessionId: envelope.sessionId,
    sequence: envelope.sequence,
    occurredAt: normalizeOccurredAt(envelope.occurredAt),
    category: envelope.category,
    type: envelope.type,
    actor: envelope.actor,
    payload: envelope.payload,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    version: envelope.version,
  };

  // An optional member holding `undefined` is an absent wire key, so drop it; `null` is kept.
  const presentMembers: Record<string, unknown> = {};
  for (const [memberName, memberValue] of Object.entries(canonicalMembers)) {
    if (memberValue !== undefined) presentMembers[memberName] = memberValue;
  }

  return canonicalizeJson(presentMembers);
}
