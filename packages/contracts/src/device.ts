// The device requests: list, link, rename, revoke, forget, push address, notification
// switches, and the desktop's control-plane calls through the background service. The keys
// and statement chain they carry belong to the trust-statement module.
//
// Two boundaries meet here, each with its own descriptor table. The control plane serves
// `device.list`, linking, rename, revoke, forget, `device.statementList` and
// `device.pushAddressSet`; a machine's service serves `device.statementApply`,
// `device.trustedList`, `device.notificationSettingsSet` and `controlPlane.call`.
import { z } from "zod";

import { decodedByteLength } from "./internal/base64.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "./method-descriptor.js";
import {
  NotificationKindSwitchesSchema,
  type NotificationKindSwitches,
} from "./machine-settings.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import type { RuntimeNodeProcedureDescriptors } from "./runtime-node.js";
import { wireFreeFormString } from "./free-form-string.js";
import {
  ChannelPublicKeySchema,
  DeviceIdSchema,
  DeviceLinkedStatementSchema,
  DeviceRenamedStatementSchema,
  DeviceRevokedStatementSchema,
  IdentityPublicKeySchema,
  MACHINE_OR_DEVICE_NAME_MAX_LEN,
  MachineIdentityKeySchema,
  PasskeyIdSchema,
  PLATFORM_DESCRIPTION_MAX_LEN,
  TRUST_STATEMENT_KINDS,
  TrustSignerSchema,
  TrustStatementHashSchema,
  TrustStatementSchema,
  type ChannelPublicKey,
  type DeviceId,
  type DeviceLinkedStatement,
  type DeviceRenamedStatement,
  type DeviceRevokedStatement,
  type IdentityPublicKey,
  type MachineIdentityKey,
  type TrustSigner,
  type TrustStatement,
  type TrustStatementKind,
} from "./trust-statement.js";
import { isoDateTimeSchema } from "./internal/wire-scalars.js";

/** The longest app or service version string. */
export const APP_VERSION_MAX_LEN = 64;
/** The longest pairing id the control plane mints for one link. */
export const PAIRING_ID_MAX_LEN = 256;
/** The longest push address: an APNs or FCM token, or a Web Push endpoint. */
export const PUSH_ADDRESS_MAX_LEN = 2048;

const NameSchema = wireFreeFormString(MACHINE_OR_DEVICE_NAME_MAX_LEN, "name");
const PlatformSchema = wireFreeFormString(PLATFORM_DESCRIPTION_MAX_LEN, "platform");

// device.list: the machines, devices and passkeys, live

/** A machine card's facts. `This machine` is the reader's own comparison of `nodeId`. */
export interface MachineEntry {
  nodeId: NodeId;
  name: string;
  platform: string;
  serviceVersion: string;
  /** Whether the machine holds its relay connection now. */
  reachable: boolean;
  /** The end of its last relay connection; `null` while it has never connected. */
  lastSeenAt: string | null;
}
/** Parses a {@link MachineEntry}. */
export const MachineEntrySchema: z.ZodType<MachineEntry> = z
  .object({
    nodeId: NodeIdSchema,
    name: NameSchema,
    platform: PlatformSchema,
    serviceVersion: wireFreeFormString(APP_VERSION_MAX_LEN, "serviceVersion"),
    reachable: z.boolean(),
    lastSeenAt: isoDateTimeSchema.nullable(),
  })
  .strict();

/** A device card's facts. */
export interface DeviceEntry {
  deviceId: DeviceId;
  name: string;
  platform: string;
  appVersion: string;
  /** Whether the device holds a relay connection now. */
  connected: boolean;
  /** The end of its last relay connection; `null` while it has never connected. */
  lastSeenAt: string | null;
  linkedAt: string;
  /** Whose key linked it, so a device a since-revoked device linked is flagged. */
  linkedBy: TrustSigner;
  /** When it was revoked; `null` while it is trusted. A revoked card sits in `Revoked`. */
  revokedAt: string | null;
  /** The machines that have not yet fetched its revoke; each drops it when it next connects. */
  revokePendingOnNodeIds: NodeId[];
  /** Its key kept displacing its own connection, so it is in two places at once. */
  seenInTwoPlaces: boolean;
}
/** Parses a {@link DeviceEntry}. */
export const DeviceEntrySchema: z.ZodType<DeviceEntry> = z
  .object({
    deviceId: DeviceIdSchema,
    name: NameSchema,
    platform: PlatformSchema,
    appVersion: wireFreeFormString(APP_VERSION_MAX_LEN, "appVersion"),
    connected: z.boolean(),
    lastSeenAt: isoDateTimeSchema.nullable(),
    linkedAt: isoDateTimeSchema,
    linkedBy: TrustSignerSchema,
    revokedAt: isoDateTimeSchema.nullable(),
    revokePendingOnNodeIds: z.array(NodeIdSchema),
    seenInTwoPlaces: z.boolean(),
  })
  .strict();

/** A passkey row's facts. */
export interface PasskeyEntry {
  passkeyId: string;
  /** The platform that holds it. */
  platform: string;
  addedAt: string;
  /** Whose key added it, so a passkey a since-revoked device added is flagged. */
  addedBy: TrustSigner;
}
/** Parses a {@link PasskeyEntry}. */
export const PasskeyEntrySchema: z.ZodType<PasskeyEntry> = z
  .object({
    passkeyId: PasskeyIdSchema,
    platform: PlatformSchema,
    addedAt: isoDateTimeSchema,
    addedBy: TrustSignerSchema,
  })
  .strict();

/** `device.list` takes nothing: the account is the caller's. */
export type DeviceListRequest = Record<string, never>;
/** Parses a {@link DeviceListRequest}. */
export const DeviceListRequestSchema: z.ZodType<DeviceListRequest, DeviceListRequest> = z
  .object({})
  .strict();

/** The list now, which the live read answers with before its first change. */
export interface DeviceListSnapshot {
  machines: MachineEntry[];
  devices: DeviceEntry[];
  passkeys: PasskeyEntry[];
}
/** Parses a {@link DeviceListSnapshot}. */
export const DeviceListSnapshotSchema: z.ZodType<DeviceListSnapshot> = z
  .object({
    machines: z.array(MachineEntrySchema),
    devices: z.array(DeviceEntrySchema),
    passkeys: z.array(PasskeyEntrySchema),
  })
  .strict();

/**
 * One change on the live read: a new statement, under its kind's name; a revoked
 * device's row forgotten; or a machine's registration refreshed.
 */
export type DeviceListEvent =
  | { type: TrustStatementKind; statement: TrustStatement }
  | { type: "device.forgotten"; deviceId: DeviceId }
  | { type: "runtimenode.registered"; machine: MachineEntry };
/** Parses a {@link DeviceListEvent}; a statement event's name is its statement's kind. */
export const DeviceListEventSchema: z.ZodType<DeviceListEvent> = z.union([
  z
    .object({ type: z.enum(TRUST_STATEMENT_KINDS), statement: TrustStatementSchema })
    .strict()
    .refine((event) => event.type === event.statement.kind, {
      path: ["type"],
      message: "a statement event is named by its statement's kind",
    }),
  z.object({ type: z.literal("device.forgotten"), deviceId: DeviceIdSchema }).strict(),
  z.object({ type: z.literal("runtimenode.registered"), machine: MachineEntrySchema }).strict(),
]);

// Linking

/** `device.linkStart` takes nothing: the caller is the linking side. */
export type DeviceLinkStartRequest = Record<string, never>;
/** Parses a {@link DeviceLinkStartRequest}. */
export const DeviceLinkStartRequestSchema: z.ZodType<
  DeviceLinkStartRequest,
  DeviceLinkStartRequest
> = z.object({}).strict();

/** A single-use pairing, good for 5 minutes from when it was made. */
export interface DeviceLinkStartResponse {
  pairingId: string;
  expiresAt: string;
}
/** Parses a {@link DeviceLinkStartResponse}. */
export const DeviceLinkStartResponseSchema: z.ZodType<DeviceLinkStartResponse> = z
  .object({
    pairingId: wireFreeFormString(PAIRING_ID_MAX_LEN, "pairingId"),
    expiresAt: isoDateTimeSchema,
  })
  .strict();

/**
 * The new device's half of the link: its keys, its name and platform, and a
 * SHA-256 HMAC under the link's secret, which never reaches the control plane.
 */
export interface DeviceLinkRedeemRequest {
  pairingId: string;
  identityKey: IdentityPublicKey;
  channelKey: ChannelPublicKey;
  name: string;
  platform: string;
  appVersion: string;
  mac: string;
}
/** Parses a {@link DeviceLinkRedeemRequest}. */
export const DeviceLinkRedeemRequestSchema: z.ZodType<
  DeviceLinkRedeemRequest,
  DeviceLinkRedeemRequest
> = z
  .object({
    pairingId: wireFreeFormString(PAIRING_ID_MAX_LEN, "pairingId"),
    identityKey: IdentityPublicKeySchema,
    channelKey: ChannelPublicKeySchema,
    name: NameSchema,
    platform: PlatformSchema,
    appVersion: wireFreeFormString(APP_VERSION_MAX_LEN, "appVersion"),
    mac: z
      .base64()
      .refine((value) => decodedByteLength(value) === 32, "the linking proof is 32 bytes"),
  })
  .strict();

/** One machine key the linking side trusts, which the six digits bind. */
export interface TrustedMachineKey {
  nodeId: NodeId;
  identityKey: MachineIdentityKey;
}
const TrustedMachineKeySchema: z.ZodType<TrustedMachineKey> = z
  .object({ nodeId: NodeIdSchema, identityKey: MachineIdentityKeySchema })
  .strict();

/**
 * What the new device needs to show the six digits: the linking side's name and
 * key, and the machine keys it trusts.
 */
export interface DeviceLinkRedeemResponse {
  linkingName: string;
  linkingKey: IdentityPublicKey;
  machineKeys: TrustedMachineKey[];
}
/** Parses a {@link DeviceLinkRedeemResponse}. */
export const DeviceLinkRedeemResponseSchema: z.ZodType<DeviceLinkRedeemResponse> = z
  .object({
    linkingName: NameSchema,
    linkingKey: IdentityPublicKeySchema,
    machineKeys: z.array(TrustedMachineKeySchema).min(1),
  })
  .strict();

/** `It matches`: the signed `device.linked` statement for this pairing. */
export interface DeviceLinkRequest {
  pairingId: string;
  statement: DeviceLinkedStatement;
}
/** Parses a {@link DeviceLinkRequest}. */
export const DeviceLinkRequestSchema: z.ZodType<DeviceLinkRequest, DeviceLinkRequest> = z
  .object({
    pairingId: wireFreeFormString(PAIRING_ID_MAX_LEN, "pairingId"),
    statement: DeviceLinkedStatementSchema,
  })
  .strict();

/** `Cancel`, or `It doesn't match`: the pairing ends and nothing is linked. */
export interface DeviceLinkCancelRequest {
  pairingId: string;
}
/** Parses a {@link DeviceLinkCancelRequest}. */
export const DeviceLinkCancelRequestSchema: z.ZodType<
  DeviceLinkCancelRequest,
  DeviceLinkCancelRequest
> = z.object({ pairingId: wireFreeFormString(PAIRING_ID_MAX_LEN, "pairingId") }).strict();

// Rename, revoke, forget

/** A rename, as the `device.renamed` statement the renaming device signs. */
export interface DeviceRenameRequest {
  statement: DeviceRenamedStatement;
}
/** Parses a {@link DeviceRenameRequest}. */
export const DeviceRenameRequestSchema: z.ZodType<DeviceRenameRequest, DeviceRenameRequest> = z
  .object({ statement: DeviceRenamedStatementSchema })
  .strict();

/** A revoke, as the `device.revoked` statement the revoking device signs. */
export interface DeviceRevokeRequest {
  statement: DeviceRevokedStatement;
}
/** Parses a {@link DeviceRevokeRequest}. */
export const DeviceRevokeRequestSchema: z.ZodType<DeviceRevokeRequest, DeviceRevokeRequest> = z
  .object({ statement: DeviceRevokedStatementSchema })
  .strict();

/** Removes a revoked device's row; its `device.revoked` stays in the chain. */
export interface DeviceForgetRequest {
  deviceId: DeviceId;
}
/** Parses a {@link DeviceForgetRequest}. */
export const DeviceForgetRequestSchema: z.ZodType<DeviceForgetRequest, DeviceForgetRequest> = z
  .object({ deviceId: DeviceIdSchema })
  .strict();

// The chain, fetched and handed on

/** The chain after a given statement; `null` asks for it from the start. */
export interface DeviceStatementListRequest {
  after: string | null;
}
/** Parses a {@link DeviceStatementListRequest}. */
export const DeviceStatementListRequestSchema: z.ZodType<
  DeviceStatementListRequest,
  DeviceStatementListRequest
> = z.object({ after: TrustStatementHashSchema.nullable() }).strict();

/** Statements in chain order. */
export interface DeviceStatementListResponse {
  statements: TrustStatement[];
}
/** Parses a {@link DeviceStatementListResponse}. */
export const DeviceStatementListResponseSchema: z.ZodType<DeviceStatementListResponse> = z
  .object({ statements: z.array(TrustStatementSchema) })
  .strict();

/**
 * Statements a device has seen, handed to a machine, which verifies each against
 * the chain it holds before it keeps it.
 */
export interface DeviceStatementApplyRequest {
  statements: TrustStatement[];
}
/** Parses a {@link DeviceStatementApplyRequest}. */
export const DeviceStatementApplyRequestSchema: z.ZodType<
  DeviceStatementApplyRequest,
  DeviceStatementApplyRequest
> = z.object({ statements: z.array(TrustStatementSchema).min(1) }).strict();

/** `device.trustedList` takes nothing: the view is the answering machine's own. */
export type DeviceTrustedListRequest = Record<string, never>;
/** Parses a {@link DeviceTrustedListRequest}. */
export const DeviceTrustedListRequestSchema: z.ZodType<
  DeviceTrustedListRequest,
  DeviceTrustedListRequest
> = z.object({}).strict();

/** One device as this machine's verified chain sees it. */
export interface TrustedDevice {
  deviceId: DeviceId;
  name: string;
  platform: string;
  identityKey: IdentityPublicKey;
  channelKey: ChannelPublicKey;
  /** The statement that trusts it. */
  trustedBy: string;
  /** When its key ended; `null` while it is trusted. */
  revokedAt: string | null;
}
/** A machine's own verified view of the trusted devices. */
export interface DeviceTrustedListResponse {
  devices: TrustedDevice[];
}
/** Parses a {@link DeviceTrustedListResponse}. */
export const DeviceTrustedListResponseSchema: z.ZodType<DeviceTrustedListResponse> = z
  .object({
    devices: z.array(
      z
        .object({
          deviceId: DeviceIdSchema,
          name: NameSchema,
          platform: PlatformSchema,
          identityKey: IdentityPublicKeySchema,
          channelKey: ChannelPublicKeySchema,
          trustedBy: TrustStatementHashSchema,
          revokedAt: isoDateTimeSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// Push address and notification switches

/** Where a device's pushes go. */
export const PUSH_PLATFORMS = ["apns", "fcm", "webPush"] as const;
/** One push platform. */
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * The calling device's push address: its APNs token, its FCM token or its Web Push
 * endpoint. Set at link time and whenever the platform changes it.
 */
export interface DevicePushAddressSetRequest {
  platform: PushPlatform;
  address: string;
}
/** Parses a {@link DevicePushAddressSetRequest}; a Web Push endpoint is an https address. */
export const DevicePushAddressSetRequestSchema: z.ZodType<
  DevicePushAddressSetRequest,
  DevicePushAddressSetRequest
> = z
  .object({
    platform: z.enum(PUSH_PLATFORMS),
    address: wireFreeFormString(PUSH_ADDRESS_MAX_LEN, "address"),
  })
  .strict()
  .superRefine((request, ctx) => {
    // The control plane posts to a Web Push endpoint, so anything but an https
    // address would have it send requests somewhere no push service lives.
    if (
      request.platform === "webPush" &&
      !z.url({ protocol: /^https$/u }).safeParse(request.address).success
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "a Web Push endpoint is an https address",
      });
    }
  });

/** A Web Push subscription's own keys (RFC 8291), base64url as the browser hands them over. */
export interface WebPushKeys {
  /** The subscription's 65-byte P-256 public key. */
  p256dh: string;
  /** The subscription's 16-byte authentication secret. */
  auth: string;
}
const WebPushKeysSchema: z.ZodType<WebPushKeys, WebPushKeys> = z
  .object({
    p256dh: z.base64url().length(87, "p256dh is a 65-byte key, 87 base64url characters"),
    auth: z.base64url().length(22, "auth is a 16-byte secret, 22 base64url characters"),
  })
  .strict();

/**
 * A device's own switches and push keys, handed to a machine on every connection and
 * whenever one changes. The machine keeps the copy only to decide before it sends,
 * and never edits it. `pushKey` is the 1,216-byte X-Wing public key a push is
 * sealed to, standard base64.
 */
export interface DeviceNotificationSettingsSetRequest {
  notifyOutsideTheApp: boolean;
  countOnAppIcon: boolean;
  kinds: NotificationKindSwitches;
  pushKey: string;
  webPushKeys?: WebPushKeys | undefined;
}
/** Parses a {@link DeviceNotificationSettingsSetRequest}. */
export const DeviceNotificationSettingsSetRequestSchema: z.ZodType<
  DeviceNotificationSettingsSetRequest,
  DeviceNotificationSettingsSetRequest
> = z
  .object({
    notifyOutsideTheApp: z.boolean(),
    countOnAppIcon: z.boolean(),
    kinds: NotificationKindSwitchesSchema,
    pushKey: z
      .base64()
      .refine((value) => decodedByteLength(value) === 1216, "an X-Wing public key is 1,216 bytes"),
    webPushKeys: WebPushKeysSchema.optional(),
  })
  .strict();

// The control plane's procedures, as a table

/** The device procedures the control plane serves. */
export interface DeviceProcedureDescriptors {
  readonly "device.list": SubscriptionMethodDescriptor<
    "device.list",
    DeviceListRequest,
    DeviceListSnapshot,
    DeviceListEvent
  >;
  readonly "device.linkStart": MethodDescriptor<
    "device.linkStart",
    DeviceLinkStartRequest,
    DeviceLinkStartResponse
  >;
  readonly "device.linkRedeem": MethodDescriptor<
    "device.linkRedeem",
    DeviceLinkRedeemRequest,
    DeviceLinkRedeemResponse
  >;
  readonly "device.link": MethodDescriptor<"device.link", DeviceLinkRequest, EmptyPayload>;
  readonly "device.linkCancel": MethodDescriptor<
    "device.linkCancel",
    DeviceLinkCancelRequest,
    EmptyPayload
  >;
  readonly "device.rename": MethodDescriptor<"device.rename", DeviceRenameRequest, EmptyPayload>;
  readonly "device.revoke": MethodDescriptor<"device.revoke", DeviceRevokeRequest, EmptyPayload>;
  readonly "device.forget": MethodDescriptor<"device.forget", DeviceForgetRequest, EmptyPayload>;
  readonly "device.statementList": MethodDescriptor<
    "device.statementList",
    DeviceStatementListRequest,
    DeviceStatementListResponse
  >;
  readonly "device.pushAddressSet": MethodDescriptor<
    "device.pushAddressSet",
    DevicePushAddressSetRequest,
    EmptyPayload
  >;
}

/**
 * The device procedures the control plane serves.
 *
 * @consumedBy the control plane's `device.*` procedures
 */
export const DEVICE_PROCEDURE_DESCRIPTORS: DeviceProcedureDescriptors = defineMethodDescriptors({
  "device.list": {
    method: "device.list",
    procedureType: "subscription",
    mutating: false,
    requestSchema: DeviceListRequestSchema,
    responseSchema: DeviceListSnapshotSchema,
    emissionSchema: DeviceListEventSchema,
  },
  "device.linkStart": {
    method: "device.linkStart",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceLinkStartRequestSchema,
    responseSchema: DeviceLinkStartResponseSchema,
  },
  "device.linkRedeem": {
    method: "device.linkRedeem",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceLinkRedeemRequestSchema,
    responseSchema: DeviceLinkRedeemResponseSchema,
  },
  "device.link": {
    method: "device.link",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceLinkRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "device.linkCancel": {
    method: "device.linkCancel",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceLinkCancelRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "device.rename": {
    method: "device.rename",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceRenameRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "device.revoke": {
    method: "device.revoke",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceRevokeRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "device.forget": {
    method: "device.forget",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceForgetRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "device.statementList": {
    method: "device.statementList",
    procedureType: "query",
    mutating: false,
    requestSchema: DeviceStatementListRequestSchema,
    responseSchema: DeviceStatementListResponseSchema,
  },
  "device.pushAddressSet": {
    method: "device.pushAddressSet",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DevicePushAddressSetRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
});

// The service's device methods, as a table

/** The device methods a machine's service answers over the channel. */
export interface DeviceMethodDescriptors {
  readonly "device.statementApply": MethodDescriptor<
    "device.statementApply",
    DeviceStatementApplyRequest,
    EmptyPayload
  >;
  readonly "device.trustedList": MethodDescriptor<
    "device.trustedList",
    DeviceTrustedListRequest,
    DeviceTrustedListResponse
  >;
  readonly "device.notificationSettingsSet": MethodDescriptor<
    "device.notificationSettingsSet",
    DeviceNotificationSettingsSetRequest,
    EmptyPayload
  >;
}

/**
 * The device methods a machine's service answers over the channel.
 *
 * @consumedBy a machine's service answering `device.*` over the channel
 */
export const DEVICE_METHOD_DESCRIPTORS: DeviceMethodDescriptors = defineMethodDescriptors({
  "device.statementApply": {
    method: "device.statementApply",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceStatementApplyRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "device.trustedList": {
    method: "device.trustedList",
    procedureType: "query",
    mutating: false,
    requestSchema: DeviceTrustedListRequestSchema,
    responseSchema: DeviceTrustedListResponseSchema,
  },
  "device.notificationSettingsSet": {
    method: "device.notificationSettingsSet",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DeviceNotificationSettingsSetRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
});

// controlPlane.call: the desktop's control-plane calls, through the service

/**
 * The control-plane procedures the desktop's screens call. The window holds no
 * credential, so each rides the background service, which attaches the account's
 * access token and signs the request's proof of possession. Relay negotiation and
 * every procedure not listed here are refused.
 */
export type ControlPlaneCallProcedure =
  | keyof DeviceProcedureDescriptors
  | Extract<keyof RuntimeNodeProcedureDescriptors, "runtimenode.rename" | "runtimenode.remove">;

/** The forwarded procedures, in one closed list. */
export const CONTROL_PLANE_CALL_PROCEDURES: readonly ControlPlaneCallProcedure[] = Object.freeze([
  "device.list",
  "device.linkStart",
  "device.linkRedeem",
  "device.link",
  "device.linkCancel",
  "device.rename",
  "device.revoke",
  "device.forget",
  "device.statementList",
  "device.pushAddressSet",
  "runtimenode.rename",
  "runtimenode.remove",
] as const);

/**
 * One forwarded call. `input` is the procedure's own request, which the control
 * plane's descriptor for that procedure parses, and the reply is that procedure's
 * own result.
 */
export interface ControlPlaneCallRequest {
  procedure: ControlPlaneCallProcedure;
  input: unknown;
}
/** Parses a {@link ControlPlaneCallRequest}: the procedure must be on the closed list. */
export const ControlPlaneCallRequestSchema: z.ZodType<
  ControlPlaneCallRequest,
  ControlPlaneCallRequest
> = z
  .object({
    procedure: z.enum(
      CONTROL_PLANE_CALL_PROCEDURES as readonly [
        ControlPlaneCallProcedure,
        ...ControlPlaneCallProcedure[],
      ],
    ),
    input: z.unknown(),
  })
  .strict();

/** The forwarded procedure's own result. */
export type ControlPlaneCallResponse = unknown;

/** The one method the service answers for the window's control-plane calls. */
export interface ControlPlaneMethodDescriptors {
  readonly "controlPlane.call": MethodDescriptor<
    "controlPlane.call",
    ControlPlaneCallRequest,
    ControlPlaneCallResponse
  >;
}

/**
 * The one method the service answers for the window's control-plane calls.
 *
 * @consumedBy the daemon's `controlPlane.call` handler
 */
export const CONTROL_PLANE_METHOD_DESCRIPTORS: ControlPlaneMethodDescriptors =
  defineMethodDescriptors({
    "controlPlane.call": {
      method: "controlPlane.call",
      procedureType: "mutation",
      mutating: true,
      requestSchema: ControlPlaneCallRequestSchema,
      responseSchema: z.unknown(),
    },
  });
