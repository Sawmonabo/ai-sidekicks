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
// its refusal boundary along with its bytes, and THREE refusals live on the
// GENERIC entry point: `canonicalizeJson` REFUSES any value nesting containers
// past a fixed ceiling (see `CANONICAL_JSON_MAX_DEPTH`), it REFUSES any value
// carrying a callable `toJSON` (see `assertNoToJsonOverride`), and it REFUSES
// any string or property name carrying an unpaired UTF-16 surrogate (see
// `assertWellFormedStrings`).
//
// EXACTLY TWO OF THE THREE BIND Plan-027 under CP-006-3 — its Spec-024 intake
// needs a registered rejection reason for each, an over-deep `action_payload`
// and an ill-formed one — and those two differ in KIND: the ceiling is POLICY,
// renegotiated here rather than forked around, while the well-formedness refusal
// is an RFC 8785 §3.2.2.2 normative MUST, not renegotiable in either direction.
// `Plan-006 §Cross-Plan Obligations` registers those two, and scopes the
// renegotiation affordance to the ceiling alone. The `toJSON` refusal
// deliberately adds NO third CP-006-3 row, because no Spec-024 body can reach
// it: that intake arrives via `JSON.parse`, whose output has no function-valued
// member anywhere — `{"toJSON":"x"}` yields a STRING, and a `"__proto__"` key
// parses as an ordinary own data property rather than setting a prototype — so
// the predicate `typeof value.toJSON === "function"` is unsatisfiable on parsed
// input. Its KIND is a third one besides POLICY and MUST: it enforces the
// DETERMINISM the integrity protocol assumes, that re-canonicalizing one value
// reproduces one byte string.
// The EVENT entry point carries one refusal neither generic one does:
// `canonicalizeEvent` rejects a `sequence` outside the safe-integer range,
// where distinct sequences collapse onto one IEEE-754 double and two different
// events could share a `row_hash` (see `assertRepresentableSequence`). That
// asymmetry is forced, not stylistic — RFC 8785 Appendix B MANDATES output for
// unsafe numbers, so the generic serializer has to keep serializing them.
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
// them rather than claiming this module owns every throw. The THIRD is now
// SHADOWED in both shapes that could reach it: an own-property cycle drives the
// depth walk past the ceiling and gets this module's depth wording, and a cycle
// reachable only through a `toJSON` result is refused by
// `assertNoToJsonOverride` before the serializer ever runs. What is left of it is
// the non-idempotent-accessor residual `assertWithinCanonicalDepth` documents —
// a getter handing the guards an acyclic tree and the serializer a cyclic one —
// so it stays inventoried as that residual rather than as a live path. The
// `NaN` example is
// entry-point-specific: the SAME defect routed through `canonicalizeEvent`
// meets `assertRepresentableSequence` first and gets this module's wording
// instead, since a non-integer fails the safe-integer predicate too. Nothing
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
// re-canonicalize a stored row to recompute `row_hash`, so HASH REPRODUCTION
// holds whether the append path persisted the raw or the normalized string.
//
// TAMPER-EVIDENCE DOES NOT, AND THE TWO HALVES MUST BE HELD APART. The very
// property that makes reproduction robust — many spellings, one canonical byte
// string — is the property that leaves the STORED spelling uncommitted, so a
// verifier reproducing the hash from a respelled column is agreeing with the
// attacker rather than catching them (the mechanism is the next paragraph).
// Idempotence therefore buys the read side nothing here, and no re-verification
// ever will: closing it takes a SECOND, separate check that the stored string
// is the canonical spelling of the instant the signature commits to. That check
// is `isCanonicalOccurredAt`, exported below for T4.1's range-walk.
//
// Robust reproduction is NOT a licence to persist the raw one, and the
// governing authority is the column contract, not a threat model:
// `migrations/0001-initial.ts` declares
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
// exported so it can — rather than the producer's raw input. What that buys is
// the column contract plus a canonical DEFAULT state; it does not bind the
// adversary above, who is defined by writing to the column AFTER the append path
// ran. Detecting the rewrite is `isCanonicalOccurredAt`'s, on the read side.
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

  // `-00:00` IS ACCEPTED, DELIBERATELY. RFC 3339 §4.3 distinguishes it from
  // `+00:00`/`Z` — but only to annotate that the producer's LOCAL offset is
  // unknown, on the section's own premise that "the time in UTC is known". The
  // instant is identical, §4.2's local-minus-UTC arithmetic makes the fold exact
  // (the sign yields `-0`, and `x - (-0) === x`), and RFC 9557 §2.2 — Standards
  // Track, `Updates: 3339` — has since reassigned that annotation to `Z` itself.
  // So the fold below discards no time, only provenance the canonical form has
  // no member to carry. This is the module's stated policy at the header applied
  // as written: normalize where the rewrite BOTH preserves the instant AND lands
  // in the canonical form. Refusing here would instead hard-reject conformant
  // input from a future non-JS producer.
  //
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

/**
 * Reports whether a stored `occurred_at` string is ALREADY in the canonical
 * form. The READ-SIDE answer to the many-to-one hazard the note above describes,
 * and the missing half of that column's binding: verification pins the INSTANT,
 * this pins the SPELLING, and only the two together pin the BYTES.
 *
 * WHY VERIFICATION ALONE DOES NOT COVER IT, and why composing the two DOES.
 * `daemon_signature` commits to the canonical bytes, in which `occurredAt`
 * appears NORMALIZED, so a signature verifies for every lexical spelling of the
 * signed instant — which makes `session_events.occurred_at` the one signed
 * column an at-rest attacker can rewrite while leaving verification green. The
 * canonical form, though, admits EXACTLY ONE spelling per instant: it is
 * `toISOString()`'s output, a function of the instant alone, and it is a fixed
 * point of `normalizeOccurredAt` (the pattern this reads is that function's own
 * exit check). So over a row whose signature verifies, the space is closed in both
 * directions — canonical means the stored string IS the signed string byte for
 * byte, and non-canonical means it is a respelling, which is the tamper. A row
 * where this predicate holds but the string names no instant cannot verify at
 * all: `normalizeOccurredAt` throws on it before any bytes are produced.
 *
 * IT MUST NEVER THROW, WHICH IS THE LOAD-BEARING HALF OF ITS CONTRACT rather
 * than a style preference. The consumer is T4.1's audit range-walk, which
 * verifies a SPAN of rows; a throw there aborts the walk and suppresses
 * verification of every row after the offending one, so one malformed row would
 * buy an attacker a range-wide blind spot — the exact escalation
 * `post-shred-verify.test.ts` characterizes over the read path's three existing
 * throw layers. This function is written so it can never become a fourth:
 * `RegExp.prototype.test` coerces its argument and returns, for every string and
 * for every value a `TEXT` column can hand back, and the pattern carries no `g`
 * flag, so `.test` holds no `lastIndex` state across calls.
 *
 * A LEXICAL CHECK, NOT A CALENDAR ONE — the residual, stated rather than
 * glossed. `\d{2}` admits `2026-02-30`, `2026-13-01`, and `T25:00:00`, so a
 * string naming no instant at all satisfies this predicate. Nothing is lost, per
 * the closure argument above: guard 1 or guard 3 refuses each of those one call
 * later inside {@link canonicalizeEvent}, so the two mechanisms compose — this
 * one rules out a WELL-FORMED respelling, those rule out an ill-formed one.
 * Re-deriving the calendar read-back here would duplicate guard 3 and give this
 * function a second way to disagree with it.
 *
 * DELIBERATELY NOT WIRED INTO {@link canonicalizeEvent} OR `verifyRow`. T4.1
 * owns the read path, and emitting a verdict from here would be T2 code
 * deciding a T4.1 question. The verdict itself now exists:
 * `Spec-006 §Audit Integrity (audit_integrity)`'s fifteen-value `failureMode`
 * enum carries `occurred_at_not_canonical`, paired `failurePath: 'signature'`
 * because that field names the guarantee that failed — the signature binds the
 * stored bytes — not the column the defect occupies. What this predicate
 * supplies is the check T4.1 reports that verdict from.
 *
 * IT APPLIES TO COMPACTED ROWS TOO, which is the non-obvious half.
 * `Spec-006 §Post-Compaction Integrity`'s scalar-binding check requires
 * `occurred_at` to BYTE-EQUAL the signed projection's `occurredAt`, so it
 * catches a respelling applied AFTER compaction, reporting
 * `stub_scalar_mismatch`. It cannot catch one applied BEFORE:
 * `Spec-006 §Compacted Event Format` preserves the original timestamp verbatim,
 * so a row respelled while live has the bad spelling copied into the projection,
 * signed into the stub bytes, and byte-equal to its column forever. Compaction
 * LAUNDERS the live-path defect into signed bytes, which is why this predicate
 * is the only binding that catches the respelling in either state.
 */
export function isCanonicalOccurredAt(occurredAt: string): boolean {
  return CANONICAL_OCCURRED_AT_PATTERN.test(occurredAt);
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
 * Walks own enumerable properties and never invokes `toJSON`, so THIS GUARD
 * ALONE measures a DIFFERENT tree than `canonicalize`, which recurses into the
 * `toJSON()` RESULT — and alone it under-counts: an object at depth 1 whose
 * `toJSON()` returns a 5,000-deep tree clears this walk untouched and then
 * overflows the serializer's stack (verified empirically). THE ENTRY POINT DOES
 * NOT under-refuse, though, and that is where the claim now sits:
 * {@link assertNoToJsonOverride} runs immediately after this walk and refuses any
 * value carrying a callable `toJSON` at all, so every value that survives
 * `canonicalizeJson`'s guards has a serialized tree IDENTICAL to the own-property
 * tree measured here. What remains of the divergence is the conservative
 * direction only — a deeply nested object refused here whose serialization the
 * ceiling need not have bounded — which refuses early and is harmless.
 *
 * The walk is not free of caller code, though. `Object.values` invokes own
 * enumerable GETTERS once, {@link assertNoToJsonOverride}'s `Object.values`
 * invokes each a second time, {@link assertWellFormedStrings}'s `Object.entries`
 * a third, and the serializer then invokes each a further three times per OBJECT
 * member — six in total through `canonicalizeJson`, all measured — so a
 * NON-IDEMPOTENT getter puts all four walks on different trees. That is the one
 * residual the `toJSON` refusal does not close, and the only remaining way to
 * hand the serializer a tree no guard inspected. It is unreachable on the
 * untrusted CP-006-3 path — `JSON.parse` output carries no `toJSON` and no
 * accessors.
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
 * `toJSON` result is invisible to this walk too, but it no longer reaches the
 * library either: {@link assertNoToJsonOverride} refuses the carrier one guard
 * later, before any serialization runs.
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

// --------------------------------------------------------------------------
// `toJSON` — refused outright, because it unbinds the bytes from the value.
// --------------------------------------------------------------------------
//
// `canonicalize@3.0.0` tests `typeof object.toJSON === 'function'` FIRST for
// every object — ahead of its own cycle detection and ahead of every other
// branch — and then serializes the RESULT of calling it rather than the object
// (`lib/canonicalize.js`). A value carrying a `toJSON` therefore hands the
// serializer a tree that no walk in this module has seen, and every claim the
// other two guards make is a claim about the OWN-PROPERTY tree, not about the
// bytes. Three consequences, each verified against the pinned library:
//
//   1. NON-DETERMINISM, which is the one that decides the fix SHAPE. `toJSON`
//      is arbitrary caller code, so it need not be a function of the value: a
//      counter-incrementing `toJSON` canonicalizes to `{"v":1}` on the first
//      pass and `{"v":2}` on the second, same object (measured). The whole
//      integrity protocol assumes the opposite — verification RE-CANONICALIZES
//      a rehydrated row and compares the bytes — so a value whose canonical
//      form is not a function of the value has no `row_hash` and no
//      `daemon_signature` that mean anything. No output-side check can repair
//      that: scanning the produced bytes validates ONE draw, and the next draw
//      is a different one. Only refusing the input closes it.
//   2. THE DEPTH CEILING IS EVADED, and fails DIRTY rather than refusing: a
//      depth-1 object whose `toJSON()` returns a 5,000-deep tree clears
//      {@link assertWithinCanonicalDepth} and then throws the library's
//      `RangeError: Maximum call stack size exceeded`.
//   3. THE §3.2.2.2 REFUSAL IS EVADED: `{ toJSON: () => ({ a: "\ud800" }) }`
//      clears {@link assertWellFormedStrings} and canonicalizes to
//      `{"a":"\ud800"}` — a lone surrogate through both guards.
//
// So the refusal is on the CLASS, not on the lone-surrogate axis alone. It is
// also FAIL-CLOSED by design: a caller who wants a `Date`, a `Buffer`, or a
// domain object in the canonical bytes applies the conversion itself and hands
// this module the converted plain-JSON value, which puts the projection under
// the caller's version control instead of a prototype's.
//
// THE TRAP THIS GUARD EXISTS TO AVOID, stated because an own-property spelling
// of it would read correct and close nothing. `typeof object.toJSON` is a
// PROTOTYPE-CHAIN lookup, and the two most likely carriers inherit it:
// `Object.entries(new Date())` is `[]` and `Object.hasOwn(new Date(), "toJSON")`
// is `false`, while `typeof new Date().toJSON` is `"function"` (all measured;
// `Buffer` behaves identically). A guard written with `Object.hasOwn` or
// own-property enumeration therefore waves `Date` and `Buffer` straight through.
// The predicate below is the LIBRARY'S OWN test, character for character, which
// is the only spelling that refuses exactly the set the library would divert.
// `Uint8Array` carries NO `toJSON` — `typeof new Uint8Array([1]).toJSON` is
// `undefined` — so the crypto-relevant byte type is untouched by this refusal,
// and a member literally NAMED `toJSON` whose VALUE is a string is untouched
// too, which is what keeps every `JSON.parse`d body admissible.

/**
 * Refuses any value carrying a callable `toJSON`, at any depth.
 *
 * ITERATIVE BY CONSTRUCTION and RUNS STRICTLY AFTER THE DEPTH GUARD, for the
 * reasons {@link assertWellFormedStrings} states at length and this docblock does
 * not restate: a recursive walk over untrusted input trades one stack overflow
 * for another, and this walk carries no cycle detection of its own, so it is
 * safe only because {@link assertWithinCanonicalDepth} reports a cyclic
 * own-property graph as depth exhaustion and throws first.
 *
 * IT RUNS BEFORE {@link assertWellFormedStrings}, AND THAT ORDER IS LOAD-BEARING
 * IN THE OTHER DIRECTION. This refusal is what makes the well-formedness verdict
 * a statement about the bytes rather than about a tree the serializer may
 * discard, so it has to precede it. Reversed, a value carrying BOTH a `toJSON`
 * and a lone surrogate in its own-property tree would report the surrogate — a
 * defect in a subtree that would never have been serialized — and the accurate
 * diagnosis would be the one withheld.
 *
 * THE PROPERTY PATH IS NEVER INTERPOLATED, on the same trade
 * {@link assertNoLoneSurrogate} makes and for the same reason: T2.4's PII codec
 * calls `canonicalizeJson(input.piiPayload)` directly, so this guard runs over
 * PII plaintext and its message reaches logs. Property NAMES are caller data
 * there too, so the message reports the nesting DEPTH — structure, which the
 * depth ceiling's refusal already discloses — and nothing else.
 *
 * ONE RESIDUAL, and it is a relocation rather than a new class: a HOSTILE
 * accessor named `toJSON` runs on the `typeof` read below, so a throwing one
 * surfaces its own error instead of this module's wording. The library performs
 * the identical read one step later, so the throw was always going to happen;
 * only which line it happens on has moved.
 */
function assertNoToJsonOverride(value: unknown): void {
  // Each entry pairs a node with how many containers sit above it, so the
  // message can locate the offender without naming a property. The root is
  // seeded only if it is an object at all: `typeof` on a primitive can never
  // yield a callable `toJSON`, and the library reaches its own `toJSON` branch
  // only after the same `typeof object !== 'object'` early return.
  const pending: Array<{ readonly node: object; readonly containersAbove: number }> = [];
  if (value !== null && typeof value === "object") {
    pending.push({ node: value, containersAbove: 0 });
  }
  while (pending.length > 0) {
    // Guaranteed by the loop condition — same register as the walks above.
    const entry = pending.pop()!;
    // THE LIBRARY'S OWN TEST, deliberately not `Object.hasOwn`: a
    // prototype-chain read is the only one that sees `Date.prototype.toJSON`.
    // See the trap note above.
    if (typeof (entry.node as { readonly toJSON?: unknown }).toJSON === "function") {
      throw new Error(
        `RFC 8785 canonicalization refused: ${
          entry.containersAbove === 0
            ? "the top-level value"
            : `a value nested ${String(entry.containersAbove)} containers deep`
        } carries a callable toJSON, which canonicalize@3.0.0 invokes and serializes INSTEAD of the value — so the bytes hashed into row_hash and signed as daemon_signature would come from a tree none of this module's guards inspected, and a stateful toJSON makes two canonicalizations of one value produce DIFFERENT bytes, which no verifier recomputing row_hash can survive. Apply the conversion explicitly and pass the converted plain-JSON value instead. The property path is withheld: this entry point also canonicalizes PII plaintext.`,
      );
    }
    // Container-filtered pushes and the `Object.values` cast, both for the
    // reasons {@link assertWithinCanonicalDepth} gives; a scalar child can carry
    // no `toJSON` the library would consult.
    for (const childValue of Object.values(entry.node as Record<string, unknown>)) {
      if (childValue !== null && typeof childValue === "object") {
        pending.push({ node: childValue, containersAbove: entry.containersAbove + 1 });
      }
    }
  }
}

// --------------------------------------------------------------------------
// Unicode well-formedness — the refusal RFC 8785 §3.2.2.2 MANDATES.
// --------------------------------------------------------------------------
//
// RFC 8785 §3.2.2.2 closes with a normative Note, quoted verbatim: "Since
// invalid Unicode data like "lone surrogates" (e.g., U+DEAD) may lead to
// interoperability issues including broken signatures, occurrences of such data
// MUST cause a compliant JCS implementation to terminate with an appropriate
// error." It is the same normative register as §3.2.2.3's NaN / Infinity Note,
// which this module already honors through `canonicalize@3.0.0`'s own two
// throws — so the two Notes are treated alike rather than one being read as
// advisory.
//
// `canonicalize@3.0.0` DOES NOT terminate. It routes every string and every
// property name through `JSON.stringify`, and ES2019's well-formed
// `JSON.stringify` escapes a lone surrogate as `\ud800` instead of emitting
// ill-formed UTF-16. The output is therefore VALID JSON TEXT — it round-trips
// through `JSON.parse` and reports `isWellFormed()` — which is exactly what
// makes the defect quiet: nothing downstream looks wrong. What it is not is
// CONFORMING. A conforming independent verifier handed the same event
// terminates rather than producing bytes, so this module would brand, chain,
// and sign a byte string no conforming implementation will ever agree is the
// canonical form of that event — the precise failure
// `Spec-006 §Canonical Serialization Rules` names when it says two honest
// implementations that diverge here "produce incompatible hashes and signatures
// for identical events".
//
// REACHABLE, NOT HYPOTHETICAL — and this is where it parts company with the
// library's other three refusals. The header notes that the untrusted CP-006-3
// path arrives via `JSON.parse`, which produces no `NaN`, no `Infinity`, and no
// cycle. `JSON.parse` DOES produce lone surrogates: `"\ud800"` is a six-ASCII-
// character escape in the wire text, so the ill-formed value survives transport
// through a well-formed document. Nothing upstream refuses it — verified by
// parsing such an envelope: `EventEnvelopeSchema` admits lone surrogates in
// `actor`, `correlationId`, `causationId`, in `payload` VALUES, and in `payload`
// KEYS, because `wireFreeFormString` bounds length and rejects NUL and
// whitespace-only but tests no well-formedness, and `payload` is an open
// `z.record(z.string(), z.unknown())`. The parse boundary could reject earlier
// and give a better-located diagnostic; it does not today, and that residual is
// stated rather than glossed. It would not remove the need for this guard in any
// case — `canonicalizeEvent` does not parse, and CP-006-3's Spec-024 bodies
// never meet `EventEnvelopeSchema` at all.
//
// WHY HERE AND NOT ON THE EVENT ENTRY POINT — the exact mirror of the argument
// {@link assertRepresentableSequence} makes for sitting there instead. That
// guard is event-specific because RFC 8785 conformance FORBIDS a generic
// unsafe-number refusal: Appendix B Table 1 lists unsafe integers as inputs with
// MANDATED outputs. This one is generic because RFC 8785 conformance REQUIRES
// it, of every string in every input, property names included. Conformance puts
// the two guards on opposite entry points, and neither placement is stylistic.

/**
 * Matches the FIRST unpaired UTF-16 surrogate code unit in a string, or nothing
 * if the string is well-formed.
 *
 * Two alternatives, one per failure shape: a HIGH surrogate not followed by a
 * low one, and a LOW surrogate not preceded by a high one. A correctly paired
 * `😀` matches neither, which is the property that keeps every
 * astral-plane character — emoji, historic scripts — serializing untouched.
 *
 * DELIBERATELY NOT `u`-FLAGGED: without the flag the engine matches UTF-16 CODE
 * UNITS, which is the level RFC 8785 §3.2.2.2 legislates at and the level a lone
 * surrogate exists at. Under `/u` the same source text is matched by code point
 * and the alternation stops meaning what it reads as.
 *
 * WHY A REGEX AND NOT `String.prototype.isWellFormed()`. The platform primitive
 * is the ES2024 spelling of exactly this predicate and would be the obvious
 * choice, but it does not typecheck here: the repo compiles at `lib: ["es2023"]`
 * (`tsconfig.node22.json`, inherited by both the src and the test project), and
 * referencing it fails with TS2550 — verified by compiling it, not assumed.
 * Moving the repo-wide lib floor to `es2024` for one guard is a toolchain change
 * with a far wider blast radius than the four lines below, and a `@ts-expect-error`
 * cast on the hot path of the integrity boundary is worse than either. No
 * third-party dependency is warranted for a two-alternative regex when the
 * pinned dependency surface here is deliberately minimal. Equivalence to the
 * primitive is not assumed either: a differential run over the boundary code
 * units and 200,000 randomized surrogate-dense strings found zero disagreements
 * with `isWellFormed()`, and the boundary cases are pinned in T2.3's suite.
 */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Refuses a string carrying an unpaired surrogate, naming WHERE it sat.
 *
 * THE OFFENDING TEXT IS NEVER INTERPOLATED. T2.4's PII codec calls
 * `canonicalizeJson(input.piiPayload)` directly, so this guard runs over PII
 * PLAINTEXT and its message reaches logs. Four throw sites are reachable
 * through that call — the depth ceiling, the `toJSON` refusal, the
 * no-JSON-representation guard, and this one — and the first three quote nothing
 * from the input at all (a fixed constant, a nesting count, and a fixed
 * sentence), which leaves this the only one whose message could carry caller
 * data if it were written the obvious way. The
 * `normalizeOccurredAt` refusals DO quote their input, but no `piiPayload` call
 * reaches them. The code unit, its index, and whether it sat in a property name
 * or a value locate the defect precisely without quoting the value — the same
 * trade `signer.ts` makes for key material.
 */
function assertNoLoneSurrogate(text: string, positionDescription: string): void {
  const match = LONE_SURROGATE_PATTERN.exec(text);
  if (match === null) return;
  // Both alternatives consume exactly ONE code unit — the lookahead and the
  // lookbehind are zero-width — so the match begins AT the offending surrogate
  // and a code-UNIT read there is the unit the pattern refused. `charCodeAt`
  // rather than `codePointAt` for the same reason the pattern is not
  // `u`-flagged: this reports at the level §3.2.2.2 legislates at.
  const codeUnit = text.charCodeAt(match.index);
  throw new Error(
    `RFC 8785 canonicalization refused: ${positionDescription} carries an unpaired UTF-16 surrogate (U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")}) at index ${String(match.index)}. RFC 8785 §3.2.2.2 requires a compliant JCS implementation to terminate on lone surrogates, but canonicalize@3.0.0 escapes them through JSON.stringify and keeps going — so these bytes would be hashed and signed here while any conforming verifier refuses to produce them at all, breaking the cross-implementation byte agreement Spec-006 §Canonical Serialization Rules depends on. The string itself is withheld: this entry point also canonicalizes PII plaintext.`,
  );
}

/**
 * Refuses any value carrying an unpaired surrogate in a string or a property
 * name, at any depth.
 *
 * BOTH POSITIONS, because RFC 8785 §3.2.2.2 legislates over both in one breath
 * — "For JSON string data (which includes JSON object property names as well)".
 * Property names are not an edge case here: they are lex-sorted into the byte
 * order per §3.2.3, so an ill-formed name is load-bearing twice over.
 *
 * ITERATIVE BY CONSTRUCTION, for the same reason {@link assertWithinCanonicalDepth}
 * is: a recursive walk over untrusted input trades one stack overflow for
 * another.
 *
 * RUNS STRICTLY AFTER THE DEPTH GUARD, AND THAT ORDER IS LOAD-BEARING RATHER
 * THAN INCIDENTAL. This walk carries no cycle detection and no depth bound of
 * its own, so on a cyclic own-property graph it would spin forever. It cannot
 * meet one: `assertWithinCanonicalDepth` reports a cycle as depth exhaustion and
 * throws first, which leaves this walk only acyclic, depth-bounded inputs.
 * Reversing the two would turn the existing cyclic-input test from a refusal
 * into a hang. The aliased-DAG caveat that guard documents applies here
 * unchanged and is not restated.
 *
 * PEAK MEMORY IS O(containers), the property the depth guard's worklist note
 * explains at length: strings are checked INLINE while iterating a container's
 * children and never queued, so a body-cap-sized `["a","a",…]` costs one heap
 * entry rather than one per element. A top-level string is handled before the
 * loop, since the loop only ever sees strings as children.
 *
 * DIVERGES FROM THE SERIALIZED TREE IN ONE DIRECTION ONLY — THE CONSERVATIVE
 * ONE — which is what lets its verdict stand for the bytes. The under-refusal
 * this walk used to carry is closed one guard EARLIER rather than here: it still
 * never invokes `toJSON`, so an object whose `toJSON()` returned
 * `{ a: "\ud800" }` would clear it, but {@link assertNoToJsonOverride} refuses
 * that carrier before this walk runs, so nothing arriving here has a serialized
 * tree it cannot see. The over-refusals remain, in two shapes, both harmless:
 * `canonicalize` DROPS an object member whose value is `undefined` or a symbol,
 * while this walk still checks that member's NAME; and it ignores an array's
 * non-index own enumerable properties, while `Object.entries` yields them here.
 * (A third shape is gone with the bypass — a `toJSON` returning a SUBSET of the
 * own-property tree left the surplus checked but never serialized.) Neither
 * remaining shape is reachable on the untrusted CP-006-3 path, where
 * `JSON.parse` output carries no `toJSON`, no accessors, no `undefined`, and no
 * symbols.
 */
function assertWellFormedStrings(value: unknown): void {
  if (typeof value === "string") {
    assertNoLoneSurrogate(value, "the top-level string");
    return;
  }
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    // Guaranteed by the loop condition — same register as the depth walk's pop.
    const node = pending.pop()!;
    if (node === null || typeof node !== "object") continue;
    // Array INDICES are generated names ("0", "1", …) and can carry no
    // surrogate, so the name check is skipped for arrays rather than run
    // against strings that cannot fail it. The cast picks the
    // indexed-signature overload, as in the depth walk above.
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
 * Canonicalizes an arbitrary JSON value to RFC 8785 bytes.
 *
 * The generic entry point, and the one CP-006-3 names: Spec-024's
 * `request_body_hash` digests an RFC-8785-canonicalized request body, and
 * Plan-027 MUST consume this function rather than re-implement the scheme.
 * {@link canonicalizeEvent} is the envelope-shaped caller of the same code
 * path, so an event and a dispatch body can never drift onto two serializers.
 *
 * REFUSAL ORDER is observable — the first guard to fire is the only one the
 * caller sees — so it is fixed here rather than left to reading order, and BOTH
 * positions are correctness constraints rather than diagnostic preferences.
 * Depth goes first because it is what makes the other two walks terminate at
 * all: neither carries cycle detection, and a cyclic own-property graph would
 * spin forever in either (see {@link assertWellFormedStrings}). The `toJSON`
 * refusal goes second because it is what makes the third guard's verdict a
 * statement about the serialized bytes rather than about the own-property tree
 * (see {@link assertNoToJsonOverride}).
 */
export function canonicalizeJson(value: unknown): CanonicalBytes {
  assertWithinCanonicalDepth(value);
  assertNoToJsonOverride(value);
  assertWellFormedStrings(value);
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

// --------------------------------------------------------------------------
// Sequence representability — keeping the canonical bytes INJECTIVE.
// --------------------------------------------------------------------------

/**
 * Refuses an envelope whose `sequence` is not a faithfully-represented
 * integer.
 *
 * WHAT BREAKS WITHOUT IT: `sequence` is contracted as an integer but travels
 * as an IEEE-754 binary64 double, which holds integers faithfully only to
 * 2^53 − 1. Past that, distinct integers collapse onto one double —
 * `9007199254740992 === 9007199254740993` is `true`. Two genuinely different
 * events then canonicalize to IDENTICAL bytes, hash to an identical
 * `row_hash`, and collide inside the very chain `Spec-006 §Integrity Protocol`
 * builds to make tampering detectable. This function is the last place that
 * collision can be caught: one line later the two inputs are indistinguishable
 * — the same number — and RFC 8785 correctly serializes the collapsed value
 * with no way to know two different events produced it.
 *
 * WHY IT IS NOT IN `canonicalizeJson`. Two independent reasons, either
 * sufficient. First, RFC 8785 conformance FORBIDS it: Appendix B Table 1 — the
 * vector set T2.3 binds this module to — includes unsafe integers and `1e30`
 * as inputs with mandated outputs, so a generic unsafe-number refusal would
 * fail the specification the module implements. Second, the two entry points
 * carry different contracts, and this one is event-specific: `sequence` is
 * declared an INTEGER, so a value that is not a faithful integer violates its
 * own contract, whereas an arbitrary `payload` number is declared a JSON
 * NUMBER — a double — and collapses relative to nothing. `canonicalizeJson`
 * stays the generic serializer CP-006-3 hands untrusted Spec-024 bodies; event
 * semantics live here.
 *
 * WHY `Number.isSafeInteger` AND NOT `sequence > EVENT_ENVELOPE_SEQUENCE_MAX`.
 * A bare upper-bound compare has three holes on exactly the path this guard
 * exists for — the DIRECT caller who never parsed the envelope, and so is not
 * pre-filtered by the wire schema. `NaN > max` is `false`, `-Infinity > max`
 * is `false`, and `1.5 > max` is `false`, so all three would sail through;
 * negative collapse below −2^53 would too. Spelling the guard out as
 * `Number.isInteger(x) && x <= max && x >= -max` just re-derives
 * `Number.isSafeInteger` by hand. The predicate IS the property the bytes
 * need: faithfully representable. `NaN` and `Infinity` would otherwise reach
 * `canonicalize@3.0.0`'s own two refusals (see the header inventory) and
 * surface with bare library wording; this guard now precedes them for
 * `sequence` specifically, which is a strict diagnostic improvement.
 *
 * DELIBERATELY NOT IMPORTED: the contracts-package
 * `EVENT_ENVELOPE_SEQUENCE_MAX` names the same boundary, and this module still
 * does not depend on it. Importing would make the two surfaces agree BY
 * CONSTRUCTION, including agreeing on a wrong value; keeping them independent
 * lets a test assert they agree at the boundary and actually fail if either
 * side drifts. That test is the drift guard a shared const could not be.
 *
 * NON-NEGATIVITY IS NOT RE-CHECKED — a residual, stated rather than glossed. A
 * negative safe integer is represented perfectly faithfully, so it is no
 * byte-fidelity problem; it violates the schema's `.nonnegative()`, a DOMAIN
 * rule. This module validates no other member against its schema — it does not
 * check `version` against the `MAJOR.MINOR` pattern or `category` against the
 * enum — and re-checking one member's domain here would imply it checks all.
 *
 * A SECOND RESIDUAL, out of this guard's reach: `sourceEpoch` and
 * `sourcePosition` (contracts `SourceEpochSchema` / `SourcePositionSchema`)
 * are likewise contracted as integers, but they ride INSIDE `payload`, an open
 * record this module sees as untyped JSON. They carry the identical collapse
 * hazard and no guard here can see them; the parse boundary is their only
 * enforcement today.
 */
function assertRepresentableSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence)) {
    // The interpolated value is already the COLLAPSED one for an out-of-range
    // input — `String(9007199254740993)` renders "9007199254740992" — which is
    // the failure itself made visible, not a reporting defect.
    throw new Error(
      `RFC 8785 canonicalization refused: sequence ${String(sequence)} is not a safe integer (|value| must be at most ${String(Number.MAX_SAFE_INTEGER)}, and it must be an integer). Outside that range distinct sequences collapse onto the same IEEE-754 double, so two different events would produce identical canonical bytes and an identical row_hash — a collision in the chain that Spec-006 §Integrity Protocol relies on being injective.`,
    );
  }
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
 *
 * REFUSAL ORDER is observable, so it is fixed here rather than left to
 * evaluation order: {@link assertRepresentableSequence} runs FIRST, ahead of
 * the projection literal and therefore ahead of `normalizeOccurredAt`. An
 * envelope defective in both members reports the sequence refusal and never
 * the timestamp one. The full observable order on this entry point is
 * sequence → `occurredAt` → the depth ceiling → the `toJSON` refusal → Unicode
 * well-formedness, the last three inherited from {@link canonicalizeJson} and
 * ordered there.
 *
 * This entry point is the integrity boundary for BOTH write paths: T2.4's PII
 * codec builds its own member literal but routes through this function, so the
 * sequence guard covers the PII path structurally, with no second call site.
 */
export function canonicalizeEvent(envelope: EventEnvelope): CanonicalBytes {
  // Ahead of everything else — see REFUSAL ORDER above. The wire schema bounds
  // `sequence` at the parse boundary, but `canonicalizeEvent` does not parse:
  // an in-process caller constructing an `EventEnvelope` literal reaches the
  // hash chain having met no schema at all, and that caller is precisely who
  // this guard is for.
  assertRepresentableSequence(envelope.sequence);

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
