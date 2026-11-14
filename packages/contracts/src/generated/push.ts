// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The push contract: a machine hands the control plane one sealed notice for one of the person's devices, sealed to the device's own push key.

import type { SchemaCheck } from "../schema-check.js";
import { validateEmptyPayload } from "./checks/method-descriptor.js";
import { validateDevicePushSendRequest } from "./checks/push.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import type { EmptyPayload } from "./method-descriptor.js";
import type { DeviceId } from "./trust-statement.js";

/** The most sealed bytes one push carries: every platform's 4 KB payload limit. */
export const PUSH_SEALED_NOTICE_MAX_BYTES = 4096 as const;

/** Every [`PushUrgency`]. */
export const PUSH_URGENCIES = ["high", "normal"] as const;

/**
 * How soon the push service delivers a notice: `Waiting on you` and a workflow's Notify step go
 * at `high`; `Finished` and `Failed` at `normal`.
 */
export type PushUrgency = "high" | "normal";
/**
 * The id a later notice for the same moment replaces an earlier one under: 1 to 32 base64url
 * characters, which fits Web Push's `Topic` header, the tightest of the three platforms.
 */
export type PushCollapseId = string;

/**
 * One sealed push. Every push expires 24 hours after its moment.
 */
export interface DevicePushSendRequest {
  /**
   * The device the notice is for.
   */
  deviceId: DeviceId;
  /**
   * The notice, sealed to the device's push key.
   */
  sealed: string;
  /**
   * Derived from the moment's stable id.
   */
  collapseId: PushCollapseId;
  /**
   * How soon to deliver it.
   */
  urgency: PushUrgency;
  /**
   * When the push services drop it undelivered.
   */
  expiresAt: WireInstant;
}

export {
  validateDevicePushSendRequest,
  validatePushCollapseId,
  validatePushUrgency,
} from "./checks/push.js";

/** The methods of {@link PUSH_METHOD_DESCRIPTORS}, each with its checks. */
export interface PushMethodDescriptors {
  readonly "device.push.send": {
    readonly method: "device.push.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DevicePushSendRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The push procedure the control plane serves. */
export const PUSH_METHOD_DESCRIPTORS: PushMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "device.push.send": /* @__PURE__ */ Object.freeze({
    method: "device.push.send",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDevicePushSendRequest,
    responseCheck: validateEmptyPayload,
  }),
});
