// The wire error envelope and the total readers every rejection path shares: a guarded property
// read, a guarded `instanceof`, the envelope reader, and a stringifier that cannot throw.
// `rejection.ts` builds the renderer's refusal from these. It imports nothing.
//
// Envelope questions are answered by readers that return a snapshot, never by a type predicate:
// a predicate narrows the unvalidated source, whose next property access is the throw these
// guards exist to prevent. See `readWireErrorEnvelope`.

/**
 * The code+message shape typed wire errors carry. Structural, because it arrives both as a plain
 * wire object and as an `Error` subclass carrying the code.
 */
export interface WireErrorEnvelope {
  readonly code: string;
  readonly message: string;
}

/**
 * The text rendered where a value cannot be rendered as itself. Shared by {@link lossyStringify}
 * and `rejection.ts` so a renderer never sees two spellings of "could not be read".
 */
export const UNREPRESENTABLE_VALUE_TEXT = "[unrepresentable value]";

/**
 * Whether a value can carry properties at all: an object or a function, not null. A
 * null-prototype function carrying `code` and `message` is a valid envelope.
 */
export function isPropertyContainer(value: unknown): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * Reads one property off an arbitrary rejected value and cannot throw. A getter or Proxy trap
 * that throws reads as `undefined`, the same as an absent member.
 */
export function readGuardedProperty(value: unknown, key: string): unknown {
  if (!isPropertyContainer(value)) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` is an `Error`, and cannot throw. `instanceof` throws on a revoked Proxy or a
 * throwing `getPrototypeOf` trap; an unwalkable prototype chain reads as `false`.
 */
export function isErrorInstance(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * Reads `value` as a wire error envelope (any string `code` plus any string `message`), or
 * `undefined`. It returns the strings it already read on a fresh object, so a caller makes no
 * second access to an unvalidated value; branch on one code with
 * {@link readWireErrorEnvelopeWithCode}.
 */
export function readWireErrorEnvelope(value: unknown): WireErrorEnvelope | undefined {
  const code = readGuardedProperty(value, "code");
  const message = readGuardedProperty(value, "message");
  return typeof code === "string" && typeof message === "string" ? { code, message } : undefined;
}

/**
 * Reads `value` as a wire error envelope carrying exactly `code`, or `undefined`. Pass the
 * contracts-exported constant so the comparison stays bound to the contract. The comparison uses
 * the code the reader returned, so each member is accessed once.
 */
export function readWireErrorEnvelopeWithCode<TCode extends string>(
  value: unknown,
  code: TCode,
): { readonly code: TCode; readonly message: string } | undefined {
  const envelope = readWireErrorEnvelope(value);
  return envelope?.code === code ? { code, message: envelope.message } : undefined;
}

/**
 * Renders any value as a string and cannot throw. Bare `String(...)` throws for a null-prototype
 * value with no `toString` or a hostile `toString`; the fallback is a constant because even
 * `Object.prototype.toString.call` can throw through a `Symbol.toStringTag` getter.
 */
export function lossyStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNREPRESENTABLE_VALUE_TEXT;
  }
}

/**
 * Renders a rejection as an `Error`, for a component whose view state holds one;
 * `normalizeWireRejection` returns a `Refusal` instead.
 *
 *   - A wire envelope, or an `Error` carrying a wire `code`, is rebuilt as a fresh `Error` whose
 *     `name` is the wire code. This is checked first.
 *   - Any other `Error` passes through unchanged.
 *   - Anything else is wrapped through {@link lossyStringify}, so this never throws.
 */
export function wireRejectionToError(rejection: unknown): Error {
  const envelope = readWireErrorEnvelope(rejection);
  if (envelope !== undefined) {
    const envelopeError = new Error(envelope.message);
    envelopeError.name = envelope.code;
    return envelopeError;
  }
  if (isErrorInstance(rejection)) {
    return rejection;
  }
  return new Error(lossyStringify(rejection));
}
