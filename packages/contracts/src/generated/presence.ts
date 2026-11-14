// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Presence: which of the person's devices are connected to this machine, and whether an app window is in front on each.

import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { EmptyPayload } from "./method-descriptor.js";
import type { DeviceId } from "./trust-statement.js";

/** The longest device category, such as "desktop" or "mobile", in code points. */
export const DEVICE_TYPE_MAX_LEN = 64 as const;

/**
 * A device's report to a machine, sent when `appVisible` changes and otherwise every 15 seconds on
 * each machine connection the device holds. It names no device: the machine files it under the
 * device of the connection that carried it.
 */
export interface PresenceHeartbeatSendRequest {
  /**
   * The device's category.
   */
  deviceType: string;
  /**
   * An app window is in front on this device; a window behind a locked or sleeping screen is
   * not.
   */
  appVisible: boolean;
}
/**
 * One device connected to this machine: the last heartbeat the machine holds from it, under the
 * device that sent it.
 */
export interface ConnectedDevice {
  /**
   * The device.
   */
  deviceId: DeviceId;
  /**
   * Its category.
   */
  deviceType: string;
  /**
   * Whether an app window is in front on it.
   */
  appVisible: boolean;
}
/**
 * The devices connected to this machine: `presence.read`'s reply, and each value
 * `presence.subscribe` pushes when a device comes, goes or changes.
 */
export interface MachinePresence {
  /**
   * The devices.
   */
  devices: ConnectedDevice[];
}

export { validatePresenceHeartbeatSendRequest } from "./checks/presence.js";

/** The methods of {@link PRESENCE_METHOD_DESCRIPTORS}, each with its kind. */
export interface PresenceMethodDescriptors {
  readonly "presence.read": {
    readonly method: "presence.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "presence.heartbeat.send": {
    readonly method: "presence.heartbeat.send";
    readonly procedureType: "mutation";
    readonly mutating: false;
  };
  readonly "presence.subscribe": {
    readonly method: "presence.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link PRESENCE_METHOD_DESCRIPTORS}. */
export interface PresenceMethodTypes {
  readonly "presence.read": { readonly params: EmptyPayload; readonly result: MachinePresence };
  readonly "presence.heartbeat.send": {
    readonly params: PresenceHeartbeatSendRequest;
    readonly result: EmptyPayload;
  };
  readonly "presence.subscribe": {
    readonly params: EmptyPayload;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: MachinePresence;
  };
}
/** The `presence.*` methods the daemon answers. */
export const PRESENCE_METHOD_DESCRIPTORS: PresenceMethodDescriptors = /* @__PURE__ */ Object.freeze(
  {
    "presence.read": /* @__PURE__ */ Object.freeze({
      method: "presence.read",
      procedureType: "query",
      mutating: false,
    }),
    "presence.heartbeat.send": /* @__PURE__ */ Object.freeze({
      method: "presence.heartbeat.send",
      procedureType: "mutation",
      mutating: false,
    }),
    "presence.subscribe": /* @__PURE__ */ Object.freeze({
      method: "presence.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
  },
);
