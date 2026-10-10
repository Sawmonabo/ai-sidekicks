/**
 * The errors the Codex lifecycle raises: transport, timeout, provider, larger-window,
 * rewind-boundary, slot and configuration failures.
 */

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { DaemonDomainError } from "../../../../ipc/domain-error.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import {
  boundFailureDetail,
  DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE,
  LARGER_WINDOW_UNAVAILABLE_CODE,
} from "../../contract.js";

/** Substituted when a provider failure carries no usable message. */
const UNSPECIFIED_PROVIDER_FAILURE_DETAIL =
  "Codex app-server reported a failure with no diagnostic message.";

/**
 * Transport, process-level or session refusal: `driver.unavailable` plus leak-safe `fields`.
 */
export class CodexTransportError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexTransportError";
    this.fields = fields;
  }
}

/**
 * A request larger than the service said it takes, refused before it was sent, since Codex closes
 * the socket on a message past that limit. Nothing reached the provider. Carries the refusal code
 * `driver.unavailable` with `reason: "request_too_large"`.
 */
export class CodexRequestTooLargeError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(method: string, encodedByteLength: number, limit: number) {
    super(
      `The "${method}" request is ${String(encodedByteLength)} bytes, past the ` +
        `${String(limit)} the Codex service takes in one message, so it was not sent.`,
    );
    this.name = "CodexRequestTooLargeError";
    this.fields = {
      reason: "request_too_large",
      method,
      encodedByteLength: String(encodedByteLength),
      limit: String(limit),
    };
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
 * A session created on a larger window its model's catalog does not offer at that figure now
 * (`driver.larger_window_unavailable`); no conversation was started.
 */
export class CodexLargerWindowUnavailableError extends DaemonDomainError {
  constructor(model: string, largerWindow: number, offeredLargerWindow: number | undefined) {
    super("Codex's catalog does not offer this larger window for the model now.", {
      code: LARGER_WINDOW_UNAVAILABLE_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: {
        model,
        largerWindow,
        ...(offeredLargerWindow === undefined ? {} : { offeredLargerWindow }),
      },
    });
  }
}

/** JSON-RPC's invalid-request code, which Codex answers a request it refuses with. */
export const CODEX_INVALID_REQUEST_CODE = -32600;

/**
 * A provider JSON-RPC error answer; the classifier maps it to a code. `providerMessage` is the
 * wire text.
 */
export class CodexProviderRequestError extends Error {
  readonly providerErrorCode: number;
  readonly method: string;
  readonly providerMessage: string;

  constructor(method: string, providerErrorCode: number, providerMessage: string) {
    super(`Codex app-server rejected "${method}": ${providerMessage}`);
    this.name = "CodexProviderRequestError";
    this.providerErrorCode = providerErrorCode;
    this.method = method;
    this.providerMessage = providerMessage;
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
 * gate cannot see (`lastTurnId` is verified at the wire reference's pin, not at every older build
 * the driver may admit).
 */
export class CodexRewindBoundaryUnsupportedError extends Error {
  readonly code = "driver.capability_unsupported" as const;
  readonly fields: CodexRewindBoundaryUnsupportedFields;

  constructor(providerError: string) {
    super(DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE);
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
      return (
        `A create or resume for Codex session "${sessionId}" is already in flight; create ` +
        `would orphan whichever process loses.`
      );
    case "closing":
      return (
        `Codex session "${sessionId}" is still being torn down; create would spawn a ` +
        `replacement beside a process that is still exiting.`
      );
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
  return boundFailureDetail(readFailureText(cause), UNSPECIFIED_PROVIDER_FAILURE_DETAIL);
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
