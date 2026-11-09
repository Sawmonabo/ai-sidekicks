// The daemon methods the desktop calls and opens, one list per channel, and the check every request
// takes before the addon sees it: a method off its channel's list, or called as the other kind, is
// refused as `request.methodNotAllowed`, and params that fail the method's generated check as
// `request.paramsInvalid`, each in the wire's error shape a daemon refusal takes. A window's list
// is the bindings' tables and holds none of the daemon's lifecycle: stopping, restarting and
// flushing go through main's supervisor. The addon checks the params against the method's
// whole contract again as the last line.

import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { Issue } from "@ai-sidekicks/contracts/jsonrpc/issue";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";

import { issuePathOf } from "#shared/daemon/fault-path.js";
import {
  WINDOW_METHOD_DESCRIPTORS,
  type WindowMethodDescriptor,
} from "#shared/daemon/method-bindings.js";

/** Who sends a request: main over the parentPort, or a window over the port main handed it. */
export type ClientHelperChannelKind = "main" | "window";

/** Every method a window calls or opens: the generated tables the window's bindings name. */
const WINDOW_METHODS: Readonly<Record<string, WindowMethodDescriptor>> = WINDOW_METHOD_DESCRIPTORS;

/** Every method main calls or opens: a window's, and the daemon's lifecycle, which only main sends. */
const MAIN_METHODS: Readonly<Record<string, WindowMethodDescriptor>> = Object.freeze({
  ...WINDOW_METHODS,
  ...DAEMON_LIFECYCLE_METHOD_DESCRIPTORS,
});

/** Each channel's list. */
const ALLOWED_METHODS_BY_CHANNEL: Readonly<
  Record<ClientHelperChannelKind, Readonly<Record<string, WindowMethodDescriptor>>>
> = Object.freeze({ main: MAIN_METHODS, window: WINDOW_METHODS });

/**
 * Why a request for `method` from `channel` may not go to the addon, in the wire's error shape, or
 * `undefined` when it may: a method off the channel's list or made as the other kind
 * (`isSubscription` says which the asker makes), or params, read with their byte `attachments`,
 * that fail the method's check.
 */
export function requestRefusal(
  channel: ClientHelperChannelKind,
  method: string,
  params: unknown,
  attachments: readonly Uint8Array[],
  isSubscription: boolean,
): JsonRpcError | undefined {
  const allowedMethods = ALLOWED_METHODS_BY_CHANNEL[channel];
  if (!Object.hasOwn(allowedMethods, method)) {
    return refusal(
      JsonRpcErrorCode.DomainRefusal,
      "request.methodNotAllowed",
      `The app does not call ${method}`,
    );
  }
  const allowed = allowedMethods[method]!;
  if ((allowed.procedureType === "subscription") !== isSubscription) {
    return refusal(
      JsonRpcErrorCode.DomainRefusal,
      "request.methodNotAllowed",
      `${method} is not called this way`,
    );
  }
  const check = allowed.requestCheck;
  if (check.call({ attachments }, params)) {
    return undefined;
  }
  const issues = (check.errors ?? []).map((fault) => ({
    path: issuePathOf(fault.instancePath, params),
    message: `breaks the schema's "${fault.keyword}" rule`,
  }));
  return paramsRefusal(method, issues);
}

/** `request.paramsInvalid` for `method`'s params, naming each fault's place and rule. */
export function paramsRefusal(method: string, issues: readonly Issue[]): JsonRpcError {
  return refusal(
    JsonRpcErrorCode.InvalidParams,
    "request.paramsInvalid",
    `The params of ${method} break its contract`,
    { issues },
  );
}

/**
 * A refusal in the wire's error shape. Both codes this module raises the daemon files under
 * `invalidArgument`, which the generated contracts carry only as a type.
 */
function refusal(
  code: number,
  type: Extract<RefusalCode, "request.methodNotAllowed" | "request.paramsInvalid">,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): JsonRpcError {
  return {
    code,
    message,
    data:
      fields === undefined
        ? { type, category: "invalidArgument" }
        : { type, category: "invalidArgument", fields: { ...fields } },
  };
}
