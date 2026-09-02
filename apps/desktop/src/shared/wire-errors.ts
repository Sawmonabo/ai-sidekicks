// Wire-rejection helpers shared by every renderer surface — Plan-023 Phase 1B.
//
// Counted across the four sibling views in `runtime-node-attach/` before this
// module existed: THREE normalizers (`normalizeAttachError`,
// `normalizeRosterReadError`, `normalizeUnrecognizedRejection`), TWO copies of
// the generic envelope guard, TWO copies of the never-throwing stringifier, and
// TWO copies of a code-scoped below-floor recognizer — nine bodies for four
// jobs, four of them under comments that named the duplication ("LOCAL
// DUPLICATE of the sibling original …") and defended it on file-scope grounds.
// File scope is a reason to hoist, not a reason to copy: the copies are
// byte-identical, their rationales are the same rationale written out again,
// and the one deliberate divergence between them — a TOTAL wrap at a prop
// boundary versus a bare `String(...)` wrap at a catch boundary — is a
// PARAMETER, not a reason for three normalizers.
//
// This module lives in `src/shared/` rather than under `src/renderer/` because
// the same shapes cross the preload boundary in both directions and a main-side
// consumer must not have to reach into renderer source for them. It imports
// nothing at all: no `electron`, no `node:*`, not even contracts — the guards are
// structural by design (see `isWireErrorEnvelope`), so binding them to a schema
// would narrow them below what their callers need.

/**
 * The code+message-only refusal shape the typed wire errors carry.
 *
 * Structural on purpose: the same shape arrives as a plain wire object AND as an
 * `Error` subclass carrying the code (the SDK's `RuntimeNodeControlPlaneError`),
 * and a renderer arm whose job is to say WHICH refusal occurred must match both.
 */
export interface WireErrorEnvelope {
  readonly code: string;
  readonly message: string;
}

/**
 * Whether `value` is a wire error envelope.
 *
 * Shape-generic — any string `code` plus any string `message` — deliberately not
 * bound to specific code literals: a caller that needs to branch on a particular
 * code uses {@link isWireErrorEnvelopeWithCode}, and one that only needs to
 * render `code: message` must not have to enumerate every code that exists.
 */
export function isWireErrorEnvelope(value: unknown): value is WireErrorEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

/**
 * Whether `value` is a wire error envelope carrying exactly `code`.
 *
 * The narrowing form, so a caller that distinguishes one typed refusal from the
 * generic case writes the discriminant once. `===` on the code is sound because
 * every wire code is a plain single-sourced string-literal type and not a
 * nominal brand; passing the contracts-exported const rather than a free string
 * is what keeps the comparison compile-time-bound to the contract.
 */
export function isWireErrorEnvelopeWithCode<TCode extends string>(
  value: unknown,
  code: TCode,
): value is { readonly code: TCode; readonly message: string } {
  return isWireErrorEnvelope(value) && value.code === code;
}

/**
 * Renders any value as a string, and cannot throw.
 *
 * Bare `String(...)` is NOT total: it runs ToPrimitive, which itself throws for
 * a null-prototype object — or a null-prototype FUNCTION — carrying no
 * `toString` / `valueOf` / `Symbol.toPrimitive`, and a hostile throwing
 * `toString` propagates the same way. The terminal fallback is a string LITERAL,
 * deliberately not `Object.prototype.toString.call(...)`: even that can throw
 * (its `Symbol.toStringTag` lookup is a Get, and a hostile getter propagates),
 * so only a literal makes the totality claim PROVABLE rather than merely one
 * pathological layer deeper.
 */
export function lossyStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unrepresentable value]";
  }
}

/** How far {@link normalizeWireRejection} must go to render a hostile value. */
export interface NormalizeWireRejectionOptions {
  /**
   * `true` renders a non-`Error`, non-envelope rejection through
   * {@link lossyStringify} instead of bare `String(...)`.
   *
   * The boundary difference the callers encode, made a parameter. A rejection
   * that arrived through a bridge CATCH binding came off the IPC surface, where
   * a ToPrimitive-failing shape is not realistically reachable, and the bare
   * wrap states that. A rejection that arrived as a PROP admits arbitrary
   * `unknown`, so the component that exists to SURFACE a refusal must not crash
   * on the very value it is surfacing — a render throw would unmount the tree,
   * and even a future error boundary would only swap the crash for a fallback
   * that hides the node.
   */
  readonly total?: boolean;
}

/**
 * Normalizes a rejection into a render-ready `Error`.
 *
 *   • A typed wire envelope (or an `Error` carrying a wire `code`) is rebuilt as
 *     a fresh `Error` with the wire `code` as `Error.name`, so the rendered
 *     envelope reads `runtimenode.attach_conflict: …` rather than a generic
 *     class name — or `[object Object]` for a plain-object rejection. Checked
 *     FIRST, so an SDK-style `Error`-with-code renders its code.
 *   • Any other `Error` passes through unchanged.
 *   • Anything else is wrapped, per `options.total`.
 */
export function normalizeWireRejection(
  rejection: unknown,
  options: NormalizeWireRejectionOptions = {},
): Error {
  if (isWireErrorEnvelope(rejection)) {
    const envelopeError = new Error(rejection.message);
    envelopeError.name = rejection.code;
    return envelopeError;
  }
  if (rejection instanceof Error) {
    return rejection;
  }
  return new Error(options.total === true ? lossyStringify(rejection) : String(rejection));
}
