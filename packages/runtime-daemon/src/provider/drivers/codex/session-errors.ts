/**
 * The errors the Codex lifecycle raises: transport, timeout, provider, rewind-boundary, slot and
 * configuration failures.
 */

import { DRIVER_FAILURE_DETAIL_MAX_LEN, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import { CODEX_DRIVER_NAME } from "./capabilities.js";

/** Substituted when a provider failure carries no usable message. */
const UNSPECIFIED_PROVIDER_FAILURE_DETAIL =
  "Codex app-server reported a failure with no diagnostic message.";

/** Transport or process-level failure: `driver.unavailable` plus leak-safe `fields`. */
export class CodexTransportError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexTransportError";
    this.fields = fields;
  }
}

/** Line over `CODEX_MAX_LINE_LENGTH`: framing is lost, so the connection is torn down. */
export class CodexLineTooLongError extends CodexTransportError {
  constructor(retainedLength: number, limit: number) {
    super(
      `The Codex app-server sent ${retainedLength} characters with no line terminator, ` +
        `exceeding the ${limit}-character framing limit.`,
      { retainedLength: String(retainedLength), limit: String(limit) },
    );
    this.name = "CodexLineTooLongError";
  }
}

/** A request outlived its deadline. Carries `driver.timeout`. */
export class CodexRequestTimeoutError extends Error {
  readonly code = "driver.timeout" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexRequestTimeoutError";
    this.fields = fields;
  }
}

/**
 * A provider JSON-RPC error answer; the classifier maps it to a code. `providerMessage` is the
 * wire text; `providerErrorData` is verbatim because refusals carry structured detail.
 */
export class CodexProviderRequestError extends Error {
  readonly providerErrorCode: number;
  readonly method: string;
  readonly providerMessage: string;
  readonly providerErrorData: unknown;

  constructor(
    method: string,
    providerErrorCode: number,
    providerMessage: string,
    providerErrorData: unknown = undefined,
  ) {
    super(`Codex app-server rejected "${method}": ${providerMessage}`);
    this.name = "CodexProviderRequestError";
    this.providerErrorCode = providerErrorCode;
    this.method = method;
    this.providerMessage = providerMessage;
    this.providerErrorData = providerErrorData;
  }
}

const CODEX_REWIND_BOUNDARY_FIELD = "lastTurnId";

/**
 * Refusal spellings that name a field, not a method: at the pin ``missing field `threadId` `` for
 * a missing parameter and `unknown field` for an undeclared one. `unknown variant` is excluded
 * because it names a method.
 */
const CODEX_FIELD_LEVEL_REFUSAL_PHRASES: readonly string[] = ["missing field", "unknown field"];

function refusalIndictsRewindBoundaryField(providerMessage: string): boolean {
  return CODEX_FIELD_LEVEL_REFUSAL_PHRASES.some((phrase) =>
    providerMessage.includes(`${phrase} \`${CODEX_REWIND_BOUNDARY_FIELD}\``),
  );
}

/** Structured throw-site detail for {@link CodexRewindBoundaryUnsupportedError}. */
export interface CodexRewindBoundaryUnsupportedFields {
  readonly driverId: string;
  readonly flag: DriverCapabilityFlag;
  readonly providerError: string;
}

/**
 * The build accepts `thread/fork` but refuses its boundary member, which the static `rollback`
 * gate cannot see (`lastTurnId` is verified at the `0.150.1` pin, not the `0.141.0` floor).
 */
export class CodexRewindBoundaryUnsupportedError extends Error {
  readonly code = "driver.capability_unsupported" as const;
  readonly fields: CodexRewindBoundaryUnsupportedFields;

  constructor(providerError: string) {
    super("Requested capability is not supported by the driver");
    this.name = "CodexRewindBoundaryUnsupportedError";
    this.fields = {
      driverId: CODEX_DRIVER_NAME,
      flag: "rollback",
      providerError: normalizeProviderFailureDetail(providerError),
    };
  }
}

/**
 * Turns a refused `thread/fork` that names the rewind boundary field into the typed unsupported
 * error; any other cause passes through.
 */
export function classifyRewindForkFailure(cause: unknown): unknown {
  if (
    cause instanceof CodexProviderRequestError &&
    cause.method === "thread/fork" &&
    refusalIndictsRewindBoundaryField(cause.providerMessage)
  ) {
    return new CodexRewindBoundaryUnsupportedError(cause.providerMessage);
  }
  return cause;
}

/**
 * A slot is `live`, `establishing` or `closing`; a create is refused in all three, since a second
 * spawn would orphan a process.
 */
export type CodexSessionSlotState = "live" | "establishing" | "closing";

function describeSlotRefusal(sessionId: string, holderState: CodexSessionSlotState): string {
  switch (holderState) {
    case "live":
      return `A live Codex session is already bound to "${sessionId}"; create would orphan it.`;
    case "establishing":
      return `A create or resume for Codex session "${sessionId}" is already in flight; create would orphan whichever process loses.`;
    case "closing":
      return `Codex session "${sessionId}" is still being torn down; create would spawn a replacement beside a process that is still exiting.`;
  }
}

/**
 * A create for a session that already has a live process: a caller-sequencing defect, codeless.
 */
export class CodexSessionAlreadyLiveError extends Error {
  readonly sessionId: string;
  readonly holderState: CodexSessionSlotState;

  constructor(sessionId: string, holderState: CodexSessionSlotState) {
    super(describeSlotRefusal(sessionId, holderState));
    this.name = "CodexSessionAlreadyLiveError";
    this.sessionId = sessionId;
    this.holderState = holderState;
  }
}

/** The config bag lacks the shape this driver requires: a wiring defect, so codeless. */
export class CodexDriverConfigError extends Error {
  readonly field: string;

  constructor(message: string, field: string, options?: { readonly cause: unknown }) {
    super(message, options);
    this.name = "CodexDriverConfigError";
    this.field = field;
  }
}

/**
 * Makes any caught value safe for `DriverResumeResult.providerFailureDetail`, whose
 * `wireFreeFormString` schema rejects empty, whitespace-only, NUL-bearing and overlength text.
 * Total over arbitrary values.
 */
export function normalizeProviderFailureDetail(cause: unknown): string {
  const trimmed = readFailureText(cause).replaceAll("\0", "").trim();
  if (trimmed.length === 0) {
    return UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
  }
  return trimmed.length > DRIVER_FAILURE_DETAIL_MAX_LEN
    ? trimmed.slice(0, DRIVER_FAILURE_DETAIL_MAX_LEN)
    : trimmed;
}

/**
 * Extracts failure text from an arbitrary thrown value, or "" if it cannot. It never throws:
 * `String(value)` throws for a null-prototype object, and `error.message` can be a throwing
 * getter or a non-string.
 */
function readFailureText(cause: unknown): string {
  try {
    if (cause instanceof Error) {
      const message: unknown = cause.message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
      const name: unknown = cause.name;
      return typeof name === "string" ? name : "";
    }
    if (typeof cause === "string") {
      return cause;
    }
    // Other values are never serialized: the detail is persisted, and a serialized rejection could
    // carry spawn configuration, credential material included, into a durable row.
    return "";
  } catch {
    return "";
  }
}
