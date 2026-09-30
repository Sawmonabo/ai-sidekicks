// Presence: which of the person's devices are connected to this machine, and whether an app
// window is in front on each. Presence belongs to a machine, never to a session. Each device
// sends a heartbeat on each machine connection it holds; the machine keeps the last one per
// device in memory and answers `presence.read` and `presence.subscribe` from it. Nothing is
// persisted.
//
// Exported schemas are annotated `z.ZodType<T, T>` because `isolatedDeclarations` forbids
// inferred types on exports, and the schemas do not transform.
import { z } from "zod";

import { EmptyAcknowledgementSchema, type EmptyAcknowledgement } from "./device.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";
import { DEVICE_ID_MAX_LEN } from "./trust-statement.js";

/** A device's liveness as the machine last saw it. */
export type PresenceState = "online" | "idle" | "reconnecting" | "offline";
/** Parses a {@link PresenceState}. */
export const PresenceStateSchema: z.ZodType<PresenceState, PresenceState> = z.enum([
  "online",
  "idle",
  "reconnecting",
  "offline",
]);

/** The longest device category, such as "desktop" or "mobile", in characters. */
export const DEVICE_TYPE_MAX_LEN = 64;

/**
 * A device's report to a machine, sent when `appVisible` changes and otherwise every 15 seconds
 * on each machine connection the device holds. Every key is required; `focusedSessionId` is
 * `null`, never absent, when no session is in focus.
 */
export interface PresenceHeartbeat {
  deviceId: string;
  activityState: PresenceState;
  metadata: {
    deviceType: string;
    focusedSessionId: SessionId | null;
    lastActivityAt: string;
    /**
     * An app window is in front on this device. A window behind a locked or
     * sleeping screen is not in front.
     */
    appVisible: boolean;
  };
}

/** Parses a {@link PresenceHeartbeat}; both objects are strict, so an unknown key is refused. */
export const PresenceHeartbeatSchema: z.ZodType<PresenceHeartbeat, PresenceHeartbeat> = z
  .object({
    deviceId: wireFreeFormString(DEVICE_ID_MAX_LEN, "PresenceHeartbeat.deviceId"),
    activityState: PresenceStateSchema,
    metadata: z
      .object({
        deviceType: wireFreeFormString(
          DEVICE_TYPE_MAX_LEN,
          "PresenceHeartbeat.metadata.deviceType",
        ),
        focusedSessionId: SessionIdSchema.nullable(),
        lastActivityAt: z.iso.datetime({ offset: true }),
        appVisible: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** One device connected to this machine, as the machine last heard from it. */
export interface PresenceDevice {
  deviceId: string;
  deviceType: string;
  appVisible: boolean;
  state: PresenceState;
}

const PresenceDeviceSchema: z.ZodType<PresenceDevice, PresenceDevice> = z
  .object({
    deviceId: wireFreeFormString(DEVICE_ID_MAX_LEN, "PresenceDevice.deviceId"),
    deviceType: wireFreeFormString(DEVICE_TYPE_MAX_LEN, "PresenceDevice.deviceType"),
    appVisible: z.boolean(),
    state: PresenceStateSchema,
  })
  .strict();

/**
 * The devices connected to this machine: `presence.read`'s reply, and each value
 * `presence.subscribe` pushes when a device comes, goes or changes.
 */
export interface MachinePresence {
  devices: PresenceDevice[];
}

/** Parses a {@link MachinePresence}. */
export const MachinePresenceSchema: z.ZodType<MachinePresence, MachinePresence> = z
  .object({
    devices: z.array(PresenceDeviceSchema),
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
    EmptyAcknowledgement
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
    responseSchema: EmptyAcknowledgementSchema,
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
