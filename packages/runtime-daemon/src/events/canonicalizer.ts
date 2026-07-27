// RFC 8785 JSON Canonicalization Scheme (JCS) — the workspace's single source
// of canonical bytes for the audit-log integrity protocol (Plan-006 T2.1).
//
// `Spec-006 §Canonical Serialization Rules` computes BOTH the `row_hash` chain
// input and the Ed25519-signed message over the SAME canonical byte string, so
// there is exactly one implementation of RFC 8785 in this repo and everything
// that needs canonical bytes routes through it: T2.2's `signRow`, T2.4's PII
// codec, T3.1's append path, and — per CP-006-3 — Plan-027's Spec-024
// `request_body_hash`, which consumes `canonicalizeJson` rather than
// re-implementing the scheme. Two honest implementations that diverge here
// produce incompatible hashes and signatures for identical events, which is
// precisely why the divergence surface is kept to one module. Consumers inherit
// its refusal boundary along with its bytes: `canonicalizeJson` REFUSES any
// value nesting containers past a fixed ceiling (see
// `CANONICAL_JSON_MAX_DEPTH`), so Plan-027's Spec-024 intake needs a registered
// rejection reason for an over-deep `action_payload`, and a ceiling that proves
// too tight is renegotiated here rather than forked around.
//
// The serializer is `canonicalize@3.0.0` (Erdtman's RFC 8785 reference
// implementation), EXACT-pinned in package.json rather than caret-ranged: a
// silent minor bump that changed one output byte would invalidate every
// `row_hash` and `daemon_signature` already on disk. T2.3's golden-vector suite
// binds this module's output to RFC 8785 Appendix B, Table 1
// ("ECMAScript-Compatible JSON Number Serialization Samples", 26 rows) — and
// NOT to Appendix A, which is the illustrative "ECMAScript Sample
// Canonicalizer" source and publishes no vectors at all.
//
// Every refusal this module RAISES ITSELF throws a plain `Error` — a deliberate
// deferral, not an oversight, and the one place this module diverges from
// neighboring precedent (crypto-paseto exports `InvalidTokenError` /
// `InvalidKeyError`; the daemon ships a concrete `DaemonDomainError` in
// `ipc/domain-error.ts`). Three MORE refusals originate inside
// `canonicalize@3.0.0` and surface with its bare wording and no module context:
// `NaN is not allowed`, `Infinity is not allowed`, and
// `Circular reference detected`. All three are narrow rather than holes — the
// untrusted CP-006-3 path arrives via `JSON.parse`, which produces no `NaN`, no
// `Infinity`, and no cycle — but an in-process caller reaches the first two
// with a plain `canonicalizeJson({ sequence: NaN })`, so the inventory names
// them rather than claiming this module owns every throw. Nothing
// discriminates a canonicalization failure from any other throw yet, and a
// class minted before a `catch` branches on it is speculative. The migration
// target when a consumer first needs to discriminate is `DaemonDomainError`,
// which already owns the JSON-RPC wire projection, under an `event.*` code
// registered in `docs/architecture/contracts/error-contracts.md §Error Codes`
// — a NEW row there, since that file's `§Event` namespace today holds only
// the T4.3 cursor code.
//
// Refs: `Spec-006 §Canonical Serialization Rules`, `Spec-006 §Integrity Protocol`,
// `Plan-006 §Encrypt-Then-Digest-Then-Sign Order`.
import type { EventEnvelope } from "@ai-sidekicks/contracts";
import canonicalize from "canonicalize";

const utf8Encoder = new TextEncoder();

/**
 * The UTF-8 bytes produced by RFC 8785 JCS canonicalization — the exact byte
 * string that `row_hash` chains over and `daemon_signature` signs.
 *
 * Phantom-branded and constructible ONLY inside this module: no constructor,
 * cast helper, factory, or brand symbol is exported. That is the structural
 * half of I-006-2-01 — a downstream `signRow(canonical: CanonicalBytes, …)`
 * can only be handed bytes that came through here, so invoking the signer
 * before the encrypt → digest → embed → canonicalize stages is a TypeScript
 * error rather than a runtime integrity bug. Brand shape mirrors the
 * contracts-package convention (`SessionId`, `RunId`, `EventEnvelopeVersion`).
 */
export type CanonicalBytes = Uint8Array & { readonly __brand: "CanonicalBytes" };

// --------------------------------------------------------------------------
// occurredAt normalization — instant-preserving AND representable, or reject.
// --------------------------------------------------------------------------
//
// `Spec-006 §Canonical Serialization Rules` requires `occurredAt` to be RFC 3339
// UTC at millisecond precision (`YYYY-MM-DDTHH:MM:SS.sssZ`) so ordering is
// byte-stable, and `packages/contracts/src/event.ts` defers that narrowing to
// hashing time on purpose. The wire schema there is
// `z.iso.datetime({ offset: true })`, which admits a strictly wider set:
// optional seconds, an UNBOUNDED number of fractional digits, and numeric
// `±HH:MM` offsets alongside `Z`.
//
// The rule applied to that wider set: NORMALIZE ONLY WHERE THE REWRITE BOTH
// PRESERVES THE INSTANT AND LANDS IN THE CANONICAL FORM — REJECT OTHERWISE.
// Folding an offset to UTC, expanding omitted seconds, and zero-padding a short
// fraction all name the same point in time before and after, so they normalize.
//
// `normalizeOccurredAt` runs FOUR guards. Their EXECUTION order is listed here
// because it is observable — the first to fire is the only one the caller sees:
//
//   1. LEXICAL SHAPE — the pattern below refuses anything outside the wire
//      schema's lexical form.
//   2. INSTANT NON-PRESERVATION — a sub-millisecond fraction names a time the
//      canonical form cannot hold, so any rewrite MOVES the instant.
//   3. CALENDAR EXISTENCE — a field read-back refuses a date that does not
//      exist (`2026-02-30T…` names no instant to preserve). It runs AFTER
//      guard 2, not before, so an input tripping both reports the
//      sub-millisecond refusal and never the calendar one:
//      `2026-02-30T00:00:00.0001Z` is a sub-millisecond rejection.
//   4. CANONICAL-FORM UNREPRESENTABILITY — the offset fold DOES preserve the
//      instant but lands outside the four-digit-year range `toISOString()`
//      renders, in EITHER direction: `0000-01-01T00:00:00+05:00` folds back to
//      year −1 (`-000001-…`) and `9999-12-31T23:59:59-05:00` folds forward to
//      year 10000 (`+010000-…`). Both are wire-accepted — the wire schema's
//      `\d{4}` year admits `0000` and `9999` — so both reach this module.
//
// Guards 1 and 3 are INPUT guards and are no part of the policy above: they
// refuse strings naming no instant at all, so there is nothing to preserve and
// nothing to represent. Guards 2 and 4 ARE the policy's two refusal classes —
// inputs that DO name a real instant and are refused anyway.
//
// Guard 2 is a tamper-evidence property, not a tidiness one: the canonical
// bytes are what `daemon_signature` commits to, so silently discarding
// sub-millisecond digits would leave the signature NOT committing to the
// recorded timestamp — an at-rest attacker could then edit
// `session_events.occurred_at` within the discarded precision and every
// verification would still pass. Both classes are therefore refused loud, at
// the boundary, where the producer can fix it.
//
// IDEMPOTENCE IS LOAD-BEARING: normalize(normalize(t)) === normalize(t),
// because the canonical form is a fixed point of every branch below. Verifiers
// re-canonicalize a stored row to recompute `row_hash`, so byte-reproduction
// holds whether the append path persisted the raw or the normalized string.
//
// That is NOT a licence to persist the raw one, and the governing authority is
// the column contract, not a threat model: `migrations/0001-initial.ts` declares
// `occurred_at TEXT NOT NULL, -- RFC 3339 UTC with ms precision`, while the wire
// schema admits `+05:00` offsets and omitted seconds. Persisting the producer's
// raw `2026-01-01T00:00Z` therefore violates that column outright, with no
// adversary required. The tamper case is the second reason, not the first:
// normalization is MANY-TO-ONE, so `daemon_signature` commits to the INSTANT,
// never to the bytes sitting in `session_events.occurred_at`, and an attacker
// with at-rest write access can rewrite a stored `occurred_at` into a different
// lexical spelling of the same instant
// (`2026-01-01T00:00:00.000Z` → `2025-12-31T19:00:00-05:00`) — verification
// still passes, but the row drops out of every lexical date-range scan over
// that column. The append path (T3.1's `EventLogService.append`, the sole append
// path) MUST therefore persist the normalized string — `normalizeOccurredAt` is
// exported so it can — rather than the producer's raw input.
//
// Parsing is component-wise off the pattern below, never `Date.parse`: ECMA-262
// lets `Date.parse` fall back to implementation-specific heuristics for any
// string outside its own Date Time String Format, and engine leniency there
// (extra fractional digits, out-of-range days) must never be what decides a
// hash input. Same stance as crypto-paseto's `base64UrlDecode`, which refuses
// Node's lenient base64url for the same reason. The instant is assembled with
// `setUTCFullYear` / `setUTCHours` rather than `Date.UTC` because `Date.UTC`
// maps years 0–99 to 1900 + year, which would silently relocate a `0026-…`
// timestamp to 1926.

/** The canonical form — the only shape `normalizeOccurredAt` ever returns. */
const CANONICAL_OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The accepted input shape: deliberately the lexical shape of the wire schema's
// `z.iso.datetime({ offset: true })`, minus that schema's calendar
// sub-validation (re-derived by the field read-back below). Uppercase `T` / `Z`
// only — RFC 3339 §5.6 permits the lowercase spellings but the wire schema does
// not admit them, so they are rejected here rather than case-folded; accepting
// a form the producer's own parser rejects would put bytes on the hash chain
// that never passed a wire parse.
//
// Capture groups: 1 year, 2 month, 3 day, 4 hour, 5 minute, 6 second?,
// 7 fractional digits?, then ONE of the two trailing arms — `Z` (no groups) or
// a numeric offset contributing 8 sign, 9 hours, 10 minutes as a set.
const CANONICALIZABLE_OCCURRED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/;

/**
 * Normalizes an `EventEnvelope.occurredAt` to the canonical RFC 3339 UTC
 * millisecond form `YYYY-MM-DDTHH:MM:SS.sssZ`, or throws. FOUR guards refuse,
 * in the execution order documented above — a non-conforming lexical shape,
 * sub-millisecond precision, a non-existent calendar date, and an offset fold
 * landing outside the four-digit-year range — and the first to fire is the only
 * one the caller sees.
 *
 * Exported so the append path — T3.1's `EventLogService.append` — can persist
 * EXACTLY the string that was signed instead of the producer's raw input.
 * Without this affordance the append path has no way to obtain the normalized
 * form, and a raw `session_events.occurred_at` is only one of many lexical
 * spellings of the signed instant (see the many-to-one note above). In-package
 * surface for now: `src/index.ts` does not re-export this module.
 */
export function normalizeOccurredAt(occurredAt: string): string {
  const match = CANONICALIZABLE_OCCURRED_AT_PATTERN.exec(occurredAt);
  if (match === null) {
    throw new Error(
      `EventEnvelope.occurredAt must be an RFC 3339 date-time with an uppercase T separator and a Z or ±HH:MM offset per Spec-006 §Canonical Serialization Rules; received ${JSON.stringify(occurredAt)}.`,
    );
  }

  // Groups 1–5 are unconditional in the pattern, so a successful match
  // guarantees them — same non-null-assertion register as crypto-paseto's
  // `parts[0]!`. Groups 6 and 7 are optional and default below (7 nests inside
  // 6's optional group, so a fraction can appear only where seconds did).
  // Groups 8–10 are neither: they are the three parts of ONE alternation arm
  // (`(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))`), so the `Z` arm yields none of
  // them and the numeric-offset arm yields all three. They stand or fall
  // together, which makes 9 and 10 GUARANTEED wherever 8 is present (see the
  // offset read below).
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const hour = Number(match[4]!);
  const minute = Number(match[5]!);
  const second = Number(match[6] ?? "0");
  const fractionalDigits = match[7] ?? "";

  // The canonical form holds exactly three fractional digits. Trailing zeros
  // beyond the third are pure notation and fold away instant-preserved; any
  // non-zero digit past the third carries time the canonical form cannot
  // represent, so it is refused rather than truncated (see the header note).
  if (/[1-9]/.test(fractionalDigits.slice(3))) {
    throw new Error(
      `EventEnvelope.occurredAt carries sub-millisecond precision (${JSON.stringify(occurredAt)}), which the canonical form YYYY-MM-DDTHH:MM:SS.sssZ cannot represent. Truncating it here would leave daemon_signature not committing to the recorded timestamp, so the producer must emit millisecond precision per Spec-006 §Canonical Serialization Rules.`,
    );
  }
  const millisecond = Number(fractionalDigits.padEnd(3, "0").slice(0, 3));

  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, millisecond);

  // A four-digit year beside a two-digit month and day is not yet a real date,
  // so this read-back IS the calendar validator: month 13, day 0, and
  // February 30 all ROLL OVER through the setters, and a rollover necessarily
  // changes at least one of the three fields read back. Hour, minute, and
  // second are already range-bounded by the pattern, so they cannot roll.
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  ) {
    throw new Error(
      `EventEnvelope.occurredAt names a date that does not exist on the calendar: ${JSON.stringify(occurredAt)}.`,
    );
  }

  // Absent sign ⇒ the `Z` branch matched ⇒ the fields already are UTC. A
  // present sign means the numeric-offset arm matched, which guarantees groups
  // 9 and 10, so they take the same `!` as groups 1–5 rather than a `?? "0"`
  // default: in a module whose whole stance is refuse-loudly, a default here
  // would silently fold an offset to zero — shifting the signed instant by up
  // to 23 hours — if the pattern were ever edited to make them truly optional.
  const offsetSign = match[8];
  const offsetMilliseconds =
    offsetSign === undefined
      ? 0
      : (offsetSign === "-" ? -1 : 1) * (Number(match[9]!) * 60 + Number(match[10]!)) * 60_000;

  const normalized = new Date(instant.getTime() - offsetMilliseconds).toISOString();
  if (!CANONICAL_OCCURRED_AT_PATTERN.test(normalized)) {
    // The CANONICAL-FORM UNREPRESENTABILITY class from the header — a second,
    // distinct rejection from the sub-millisecond one above, and the reason the
    // policy there names two. Reachable when folding an offset pushes the
    // instant outside the four-digit-year range `toISOString()` renders as
    // `YYYY`, in BOTH directions: `0000-01-01T00:00:00+05:00` lands in year −1
    // and renders `-000001-12-31T19:00:00.000Z`, while
    // `9999-12-31T23:59:59-05:00` lands in year 10000 and renders
    // `+010000-01-01T04:59:59.000Z`. The instant survived the fold in each
    // case; the canonical form simply cannot spell it. Refuse rather than sign
    // a shape the spec does not define.
    throw new Error(
      `EventEnvelope.occurredAt does not fold into the canonical form YYYY-MM-DDTHH:MM:SS.sssZ: ${JSON.stringify(occurredAt)} normalizes to ${JSON.stringify(normalized)}.`,
    );
  }
  return normalized;
}

// --------------------------------------------------------------------------
// Nesting-depth ceiling — a stack-overflow guard on the untrusted entry point.
// --------------------------------------------------------------------------

/**
 * The deepest container nesting {@link canonicalizeJson} will serialize. Depth
 * counts CONTAINERS on the path to a value: a top-level scalar is depth 0,
 * `{}` and `[]` are depth 1, `{ "a": {} }` is depth 2. A value at depth 64 is
 * accepted; one at depth 65 is refused.
 *
 * Why a ceiling exists: `canonicalize@3.0.0` recurses once per level with no
 * guard of its own, and CP-006-3 routes UNTRUSTED Spec-024 dispatch request
 * bodies through this entry point. PARSEABLE nesting costs TWO bytes per level
 * — every `[` needs its `]` — so a ~10 KB body buys depth ~5,000, far enough to
 * turn the serializer into `RangeError: Maximum call stack size exceeded`. A
 * body-size cap set anywhere near a realistic request still admits depths well
 * past the overflow point below, so the bound has to be on depth itself.
 *
 * Why 64: measured on Node 22.12 with the default stack, `canonicalize`
 * survives to depth ~1500 (nested arrays) / ~3500 (nested objects) before
 * overflowing. That was measured from a shallow test caller, so a daemon
 * handler already deep in an async chain has strictly less stack left — which
 * is exactly why the margin here is ~23x rather than ~2x. Against that
 * headroom, no real caller comes close. Arbitrary nesting reaches this module
 * only through the OPEN-RECORD fields the contracts declare, and every one of
 * them sits shallow: Spec-024's `action_payload` — opaque to Spec-024, read
 * only by the target node's capability handler — is depth 2 inside a dispatch
 * body, leaving 62 levels; on the event side the envelope wrapper plus its
 * `payload` put every open record at depth 3, leaving 61 (`session.created`'s
 * `config` / `metadata` and the `runtime_node.capability_*` detail fields today;
 * `driver_ask`'s `input` / `response` and `channel.created`'s `config` once
 * their schemas land). That set is OPEN by construction — it grows as those
 * schemas land — so what the ceiling rests on is the headroom, never a census.
 * The ceiling is a two-way door — no persisted byte depends on it, only the
 * refusal boundary.
 */
const CANONICAL_JSON_MAX_DEPTH = 64;

/**
 * Refuses a value nested deeper than {@link CANONICAL_JSON_MAX_DEPTH}.
 *
 * ITERATIVE BY CONSTRUCTION: an explicit stack, never recursion — a recursive
 * depth check would just trade the serializer's stack overflow for its own.
 *
 * Walks own enumerable properties and never invokes `toJSON`, so it measures a
 * DIFFERENT tree than `canonicalize`, which recurses into the `toJSON()` RESULT.
 * The divergence runs both ways, and the BYPASSABLE direction is the shallow
 * one: an object at depth 1 whose `toJSON()` returns a 5,000-deep tree clears
 * this walk untouched and then overflows the serializer's stack — the guard
 * does not bound it (verified empirically). The conservative direction — a
 * deeply nested object carrying a SHALLOW `toJSON` — only over-counts and
 * refuses early, which is harmless. Nor is the walk free of caller code:
 * `Object.values` invokes own enumerable GETTERS once, and the serializer then
 * invokes each of them again (three more times per OBJECT member, measured), so
 * a non-idempotent getter likewise puts the two walks on different trees. Neither
 * of these is reachable on the untrusted CP-006-3 path — `JSON.parse` output
 * carries no `toJSON` and no accessors.
 *
 * One visit per CONTAINER: scalars are never queued, because a scalar's depth is
 * never consulted (it has no children to push and cannot itself exceed the
 * ceiling). Time is still O(input bytes) — `Object.values` materializes every
 * container's children either way — but the worklist retains only containers,
 * so PEAK MEMORY is O(containers) rather than O(nodes). That matters for the
 * adversarial shape the guard exists for: a body-cap-sized `[0,0,0,…]`, which
 * nests nothing and can never trip the ceiling, used to cost one heap entry
 * (~48 bytes: the `{node, depth}` object plus its array slot) per 2 input bytes
 * and now costs one entry total. The O(input bytes) time bound assumes a tree,
 * which is what untrusted input is — a `JSON.parse`d request body, no aliasing.
 * An in-process caller CAN hand over an aliased object graph
 * (`{ a: previous, b: previous }`, repeated), where this walk is exponential —
 * but so is `canonicalize` itself on that input, which likewise re-serializes
 * every path.
 *
 * A cycle in the WALKED own-property graph is reported as depth exhaustion, not
 * as a cycle: it drives depth up without bound, so this guard fires before
 * `canonicalize`'s own `Circular reference detected`. Both refuse; only the
 * wording differs, and tracking visited nodes here to sharpen the message would
 * duplicate work the serializer already does. A cycle reachable ONLY through a
 * `toJSON` result is invisible to this walk and surfaces as the library's
 * message instead — the same blind spot as the depth bypass above.
 */
function assertWithinCanonicalDepth(value: unknown): void {
  // Each entry pairs a value with the depth it would occupy IF it is a
  // container. Only the ROOT is seeded unconditionally — it may well be a
  // scalar — while every later push is container-filtered below, so the scalar
  // check inside the loop fires for the root and nothing else.
  const pending: Array<{ readonly node: unknown; readonly depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (pending.length > 0) {
    // Guaranteed by the loop condition — the same non-null-assertion register
    // used for the guaranteed capture groups above.
    const entry = pending.pop()!;
    if (entry.node === null || typeof entry.node !== "object") continue;
    // Always fires at exactly `CANONICAL_JSON_MAX_DEPTH + 1`: a CONTAINER any
    // deeper could only have been pushed by a container at that depth, which
    // threw first (and containers are all that is ever queued — see the push
    // filter below). So the message has no offending depth to interpolate —
    // the ceiling IS it.
    if (entry.depth > CANONICAL_JSON_MAX_DEPTH) {
      throw new Error(
        `RFC 8785 canonicalization refused: the value nests containers deeper than ${CANONICAL_JSON_MAX_DEPTH} levels. canonicalize@3.0.0 recurses once per level, so unbounded nesting is a stack-overflow denial of service on this entry point — which CP-006-3 hands untrusted Spec-024 request bodies.`,
      );
    }
    // `Object.values` covers array elements and object members alike; the cast
    // is only to pick the indexed-signature overload over the `{}` → `any[]`
    // one, since `typeof === "object"` narrows no further than `object`.
    //
    // Only CONTAINERS are queued. Queuing a scalar is observationally inert —
    // it pops back off at the `continue` above without its depth ever being
    // read — so the filter is semantics-identical (a scalar at depth 65 is
    // accepted before and after; a CONTAINER at depth 65 is refused before and
    // after) and it keeps the worklist O(containers) instead of O(nodes).
    for (const childValue of Object.values(entry.node as Record<string, unknown>)) {
      if (childValue !== null && typeof childValue === "object") {
        pending.push({ node: childValue, depth: entry.depth + 1 });
      }
    }
  }
}

/**
 * Canonicalizes an arbitrary JSON value to RFC 8785 bytes.
 *
 * The generic entry point, and the one CP-006-3 names: Spec-024's
 * `request_body_hash` digests an RFC-8785-canonicalized request body, and
 * Plan-027 MUST consume this function rather than re-implement the scheme.
 * {@link canonicalizeEvent} is the envelope-shaped caller of the same code
 * path, so an event and a dispatch body can never drift onto two serializers.
 */
export function canonicalizeJson(value: unknown): CanonicalBytes {
  assertWithinCanonicalDepth(value);
  const canonicalText = canonicalize(value);
  if (typeof canonicalText !== "string") {
    // `canonicalize` DELEGATES to `JSON.stringify` for every non-object value,
    // so a top-level value with no JSON representation (`undefined`, a
    // function, a symbol) yields no output instead of throwing — and
    // `TextEncoder.encode(undefined)` encodes the empty string, which would
    // hand the signer zero canonical bytes for an input it silently could not
    // represent. It does NOT follow `JSON.stringify`'s contract wholesale: it
    // THROWS on `NaN` / `Infinity` where `JSON.stringify` emits `null` (two of
    // the three library-originated refusals the header inventories), which is
    // why this branch is a no-output guard, not a general error funnel. CP-006-3
    // routes arbitrary Spec-024 request bodies through this same entry point,
    // so the guard closes a live hole rather than a hypothetical one.
    throw new Error(
      "RFC 8785 canonicalization produced no output: the value has no JSON representation (undefined, a function, or a symbol).",
    );
  }
  // RFC 8785 §3.2.1 specifies UTF-8 as the canonical output encoding. The
  // intermediate annotation keeps the brand assertion a plain widening of
  // `Uint8Array` rather than a double cast.
  const canonicalUtf8Bytes: Uint8Array = utf8Encoder.encode(canonicalText);
  return canonicalUtf8Bytes as CanonicalBytes;
}

/**
 * Canonicalizes an {@link EventEnvelope} to the byte string that
 * `Spec-006 §Canonical Serialization Rules` hashes into `row_hash` and signs as
 * `daemon_signature`.
 *
 * Projects the canonical eleven-member set explicitly — a member the envelope
 * happens to carry at runtime but the spec does not name is not serialized, and
 * `occurredAt` is normalized to the canonical RFC 3339 UTC millisecond form (or
 * the call is refused; see the normalization note above).
 *
 * PRECONDITION — `actor` must already be in its storage-representable shape.
 * The canonical bytes faithfully distinguish an ABSENT member from a present
 * `null`, as `Spec-006 §Canonical Serialization Rules` requires, and `actor` is
 * the canonical set's UNIQUE member that is three-state in the envelope (absent
 * / `null` / string) while two-state in storage: `session_events.actor` is a
 * nullable TEXT column and `AppendableEvent.actor` is `string | null`, so both
 * envelope no-value states collapse onto one row. Signing an envelope whose
 * `actor` is ABSENT, for a row that will persist SQL NULL, therefore emits
 * bytes a verifier rehydrating that row cannot reproduce — an untampered row
 * failing verification. `correlationId` / `causationId` are two-state in
 * storage too but carry no such hazard: the envelope types them non-nullable
 * (`string | undefined`), so every storage → envelope mapping is type-FORCED to
 * `undefined` symmetrically on both sides.
 *
 * That three-state → two-state narrowing belongs to the append path — T3.1's
 * `EventLogService.append`, the sole append path, which is handed the envelope
 * and owns the row it writes. Collapsing absent → `null` HERE would silently
 * rewrite signed bytes — the same class of error the sub-millisecond branch
 * above refuses loudly.
 */
export function canonicalizeEvent(envelope: EventEnvelope): CanonicalBytes {
  // The canonical set is exactly these eleven members. The value-typed mapped
  // annotation is the drift guard, and it pins BOTH halves: `-?` makes every
  // member required, so a twelfth envelope member added in contracts breaks
  // this literal at compile time instead of silently vanishing from the signed
  // bytes (TS2741), and `EventEnvelope[MemberName]` pins each value's type, so
  // a cross-wired `sequence: envelope.id` is a compile error (TS2322) rather
  // than silently signed bytes. `Record<keyof EventEnvelope, unknown>` would
  // catch only the first — every value being `unknown`.
  //
  // The mapped form compiles here BECAUSE of repo-wide
  // `exactOptionalPropertyTypes`: under that flag `-?` strips only the
  // synthetic missing-property type, leaving the explicit `| undefined` on
  // `actor` / `correlationId` / `causationId` intact, so the envelope's own
  // reads still satisfy it. (Verified by compiling this file with the flag
  // OFF: `-?` then also removes `undefined` and exactly those three
  // assignments fail with TS2322.)
  //
  // What NO annotation can catch is a same-typed transposition — writing
  // `causationId: envelope.correlationId` (both `string | undefined`) compiles
  // clean under this mapped type and under any other. That residue is T2.3's
  // golden vectors' to close, by construction rather than by annotation.
  //
  // Declaration order is not load-bearing — RFC 8785 §3.2.3 mandates a UTF-16
  // code-unit lex-sort of member names, so the serializer, not this literal,
  // fixes the byte order.
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

  // Present-but-null and absent MUST stay distinguishable after serialization
  // (`Spec-006 §Canonical Serialization Rules`), and JSON has no `undefined`:
  // an optional member holding `undefined` IS an absent key on the wire — that
  // is exactly what the wire schema's `.optional()` yields for a key the
  // producer never sent — so it is dropped here, while `actor: null` (the
  // canonical set's only nullable member) is kept and serializes as `null`.
  // Dropping the key in this module rather than leaning on the serializer's
  // handling of `undefined` keeps the absent-vs-null distinction a property of
  // the code that owns it. Both no-value `actor` states — absent and `null` —
  // reach this loop and emit DIFFERENT bytes, which is why the precondition
  // above puts the absent-vs-null choice on the caller: storage cannot tell the
  // two apart on the way back, so this module must be handed the shape the row
  // will hold.
  const presentMembers: Record<string, unknown> = {};
  for (const [memberName, memberValue] of Object.entries(canonicalMembers)) {
    if (memberValue !== undefined) presentMembers[memberName] = memberValue;
  }

  // `pii_payload` is deliberately NOT a member and is never added here: the
  // Spec-022 crypto-shred clears that column and the canonical bytes must
  // survive it. The `pii_ciphertext_digest` standing in for it rides inside
  // `payload`, embedded by T2.4's codec before this function is called — so it
  // needs no envelope field, no parameter, and no special case on this side.
  return canonicalizeJson(presentMembers);
}
