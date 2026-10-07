// Presence: which of the person's devices are connected to this machine, and whether an app
// window is in front on each. Presence belongs to a machine, never to a session. Each device
// sends a heartbeat on each machine connection it holds; the machine keeps the last one per
// device in memory and answers `presence.read` and `presence.subscribe` from it. Nothing is
// persisted.
//
// Exported schemas are annotated `z.ZodType<T, T>` because `isolatedDeclarations` forbids
// inferred types on exports, and the schemas do not transform.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "./method-descriptor.js";
import { wireFreeFormString } from "./free-form-string.js";
import { DEVICE_ID_MAX_LEN } from "./trust-statement.js";

/** The longest device category, such as "desktop" or "mobile", in characters. */
export const DEVICE_TYPE_MAX_LEN = 64;

/**
 * A device's report to a machine, sent when `appVisible` changes and otherwise every 15 seconds
 * on each machine connection the device holds. It names no device: the machine files it under the
 * device of the connection that carried it.
 */
export interface PresenceHeartbeat {
  deviceType: string;
  /**
   * An app window is in front on this device. A window behind a locked or
   * sleeping screen is not in front.
   */
  appVisible: boolean;
}

// The members a heartbeat carries, which each connected device's row repeats.
const presenceHeartbeatShape = {
  deviceType: wireFreeFormString(DEVICE_TYPE_MAX_LEN, "PresenceHeartbeat.deviceType"),
  appVisible: z.boolean(),
};

/** Parses a {@link PresenceHeartbeat}; the object is strict, so an unknown key is refused. */
export const PresenceHeartbeatSchema: z.ZodType<PresenceHeartbeat, PresenceHeartbeat> = z
  .object(presenceHeartbeatShape)
  .strict();

/**
 * One device connected to this machine, as `presence.read` lists it: the last heartbeat the
 * machine holds from it, under the device that sent it.
 */
export interface ConnectedDevice extends PresenceHeartbeat {
  deviceId: string;
}

// Strict, so an unknown key is refused.
const ConnectedDeviceSchema: z.ZodType<ConnectedDevice, ConnectedDevice> = z
  .object({
    deviceId: wireFreeFormString(DEVICE_ID_MAX_LEN, "ConnectedDevice.deviceId"),
    ...presenceHeartbeatShape,
  })
  .strict();

/**
 * The devices connected to this machine: `presence.read`'s reply, and each value
 * `presence.subscribe` pushes when a device comes, goes or changes.
 */
export interface MachinePresence {
  devices: ConnectedDevice[];
}

/** Parses a {@link MachinePresence}. */
export const MachinePresenceSchema: z.ZodType<MachinePresence, MachinePresence> = z
  .object({
    devices: z.array(ConnectedDeviceSchema),
  })
  .strict();

/** `presence.read` takes nothing: presence is the machine's. */
export type PresenceReadRequest = Record<string, never>;
/** Parses a {@link PresenceReadRequest}: an empty object. */
export const PresenceReadRequestSchema: z.ZodType<PresenceReadRequest, PresenceReadRequest> = z
  .object({})
  .strict();

/** `presence.subscribe` takes nothing: presence is the machine's. */
export type PresenceSubscribeRequest = Record<string, never>;
/** Parses a {@link PresenceSubscribeRequest}: an empty object. */
export const PresenceSubscribeRequestSchema: z.ZodType<
  PresenceSubscribeRequest,
  PresenceSubscribeRequest
> = z.object({}).strict();

/** The `presence.subscribe` acknowledgement: the id its pushes carry. */
export type PresenceSubscribeResponse = SubscribeAckResponse;
/** Parses a {@link PresenceSubscribeResponse}. */
export const PresenceSubscribeResponseSchema: z.ZodType<PresenceSubscribeResponse> =
  SubscribeAckResponseSchema;

/** The `presence.*` methods the daemon answers. */
export interface PresenceMethodDescriptors {
  readonly "presence.read": MethodDescriptor<"presence.read", PresenceReadRequest, MachinePresence>;
  readonly "presence.heartbeat": MethodDescriptor<
    "presence.heartbeat",
    PresenceHeartbeat,
    EmptyPayload
  >;
  readonly "presence.subscribe": SubscriptionMethodDescriptor<
    "presence.subscribe",
    PresenceSubscribeRequest,
    PresenceSubscribeResponse,
    MachinePresence
  >;
}

/** The `presence.*` methods the daemon answers: their names, how each answers, and their shapes. */
export const PRESENCE_METHOD_DESCRIPTORS: PresenceMethodDescriptors = defineMethodDescriptors({
  "presence.read": {
    method: "presence.read",
    procedureType: "query",
    mutating: false,
    requestSchema: PresenceReadRequestSchema,
    responseSchema: MachinePresenceSchema,
  },
  // Not mutating: a device outside the supported version range must still say
  // whether an app window is in front on it.
  "presence.heartbeat": {
    method: "presence.heartbeat",
    procedureType: "mutation",
    mutating: false,
    requestSchema: PresenceHeartbeatSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "presence.subscribe": {
    method: "presence.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: PresenceSubscribeRequestSchema,
    responseSchema: PresenceSubscribeResponseSchema,
    emissionSchema: MachinePresenceSchema,
  },
});
