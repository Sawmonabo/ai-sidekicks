// The daemon methods the desktop calls and opens, one list per channel, which every request is held
// to before the addon sees it: a method off its channel's list, or called as the other kind, is
// refused as `request.methodNotAllowed`, in the wire's error shape a daemon refusal takes, under
// the category the contracts file the code in. A window's list is the bindings' tables and holds
// nothing only main sends: the daemon's lifecycle, which goes through main's supervisor, the app's
// diagnostics, the machine's settings and the presence heartbeat. The addon checks the params
// against the method's whole contract.

import {
  DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS,
  type DaemonAppDiagnosticMethodTypes,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import {
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS,
  type DaemonLifecycleMethodTypes,
} from "@ai-sidekicks/contracts/daemon/lifecycle";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { Issue } from "@ai-sidekicks/contracts/jsonrpc/issue";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import { REFUSAL_CODE_CATEGORIES, type RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";
import {
  MACHINE_SETTINGS_METHOD_DESCRIPTORS,
  type MachineSettingsMethodTypes,
} from "@ai-sidekicks/contracts/machine/settings";
import {
  PRESENCE_METHOD_DESCRIPTORS,
  type PresenceMethodTypes,
} from "@ai-sidekicks/contracts/presence";

import {
  WINDOW_METHOD_DESCRIPTORS,
  type WindowMethodDescriptor,
  type WindowMethodTypes,
} from "#shared/daemon/method-bindings.js";

/** Who sends a request: main over the parentPort, or a window over the port main handed it. */
export type ClientHelperChannelKind = "main" | "window";

/**
 * The params, result and emission types of every method main calls or opens, by its wire name:
 * a window's, and those only main sends.
 */
export type MainMethodTypes = WindowMethodTypes &
  DaemonLifecycleMethodTypes &
  DaemonAppDiagnosticMethodTypes &
  MachineSettingsMethodTypes &
  PresenceMethodTypes;

/** Every method a window calls or opens: the generated tables the window's bindings name. */
const WINDOW_METHODS: Readonly<Record<string, WindowMethodDescriptor>> = WINDOW_METHOD_DESCRIPTORS;

/**
 * Every method main calls or opens: a window's, and those only main sends, the daemon's lifecycle,
 * the app's diagnostics, the machine's settings and the presence heartbeat.
 */
const MAIN_METHODS: Readonly<Record<string, WindowMethodDescriptor>> = Object.freeze({
  ...WINDOW_METHODS,
  ...DAEMON_LIFECYCLE_METHOD_DESCRIPTORS,
  ...DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS,
  ...MACHINE_SETTINGS_METHOD_DESCRIPTORS,
  ...PRESENCE_METHOD_DESCRIPTORS,
});

/** Each channel's list. */
const ALLOWED_METHODS_BY_CHANNEL: Readonly<
  Record<ClientHelperChannelKind, Readonly<Record<string, WindowMethodDescriptor>>>
> = Object.freeze({ main: MAIN_METHODS, window: WINDOW_METHODS });

/**
 * Why a request for `method` from `channel` may not go to the addon, in the wire's error shape, or
 * `undefined` when it may: a method off the channel's list or made as the other kind
 * (`isSubscription` says which the asker makes).
 */
export function requestRefusal(
  channel: ClientHelperChannelKind,
  method: string,
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
  return (allowed.procedureType === "subscription") !== isSubscription
    ? refusal(
        JsonRpcErrorCode.DomainRefusal,
        "request.methodNotAllowed",
        `${method} is not called this way`,
      )
    : undefined;
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

/** A refusal in the wire's error shape, under the category the contracts file `type` in. */
function refusal(
  code: number,
  type: Extract<RefusalCode, "request.methodNotAllowed" | "request.paramsInvalid">,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): JsonRpcError {
  const category = REFUSAL_CODE_CATEGORIES[type];
  return {
    code,
    message,
    data: fields === undefined ? { type, category } : { type, category, fields: { ...fields } },
  };
}
