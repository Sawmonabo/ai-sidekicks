// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The device requests: list, link, rename, revoke, forget, push address, notification switches, and the desktop's control-plane calls through the background service.

import type { SchemaCheck } from "../schema-check.js";
import {
  validateControlPlaneCallRequest,
  validateControlPlaneCallResponse,
  validateDeviceForgetRequest,
  validateDeviceLinkCancelRequest,
  validateDeviceLinkConfirmRequest,
  validateDeviceLinkRedeemRequest,
  validateDeviceLinkRedeemResponse,
  validateDeviceLinkStartResponse,
  validateDeviceListEvent,
  validateDeviceListSnapshot,
  validateDeviceNotificationSettingsUpdateRequest,
  validateDevicePushAddressUpdateRequest,
  validateDeviceRenameRequest,
  validateDeviceRevokeRequest,
  validateDeviceStatementApplyRequest,
  validateDeviceStatementListRequest,
  validateDeviceStatementListResponse,
  validateDeviceTrustedListResponse,
} from "./checks/device.js";
import { validateEmptyPayload } from "./checks/method-descriptor.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import type { MachineId } from "./machine/id.js";
import type { NotificationKindSwitches } from "./machine/settings.js";
import type { EmptyPayload } from "./method-descriptor.js";
import type {
  ChannelPublicKey,
  DeviceId,
  DeviceLinkedStatement,
  DeviceRenamedStatement,
  DeviceRevokedStatement,
  IdentityPublicKey,
  MachineIdentityKey,
  TrustSigner,
  TrustStatement,
  TrustStatementHash,
  TrustStatementKind,
} from "./trust-statement.js";

/** The longest app or service version string. */
export const APP_VERSION_MAX_LEN = 64 as const;

/** The longest pairing id the control plane mints for one link. */
export const PAIRING_ID_MAX_LEN = 256 as const;

/** The longest push address: an APNs token or a Web Push endpoint. */
export const PUSH_ADDRESS_MAX_LEN = 2048 as const;

/** Where a device's pushes go. */
export const PUSH_PLATFORMS = ["apns", "webPush"] as const;

/** The forwarded procedures, in one closed list. */
export const CONTROL_PLANE_CALL_PROCEDURES = [
  "device.subscribe",
  "device.link.start",
  "device.link.redeem",
  "device.link.confirm",
  "device.link.cancel",
  "device.rename",
  "device.revoke",
  "device.forget",
  "device.statement.list",
  "device.pushAddress.update",
  "machine.rename",
  "machine.remove",
] as const;

/**
 * A change on the live read that is not a statement: a revoked device's row forgotten, or a
 * machine's registration refreshed.
 */
export type DeviceListRowEvent =
  | {
      type: "device.forgotten";
      /**
       * The device.
       */
      deviceId: DeviceId;
    }
  | {
      type: "machine.registered";
      /**
       * The machine.
       */
      machine: MachineEntry;
    };
/**
 * One change on the live read: a new statement under its kind's name, or a row's change. The
 * generated check cannot compare a statement event's name with its statement's kind; the Rust
 * check does.
 */
export type DeviceListEvent = DeviceStatementEvent | DeviceListRowEvent;
/**
 * The forwarded procedure's own result.
 */
export type ControlPlaneCallResponse = unknown;
/**
 * Where a device's pushes go.
 */
export type PushPlatform = "apns" | "webPush";
/**
 * The control-plane procedures the desktop's screens call. The window holds no credential, so
 * each rides the background service, which attaches the account's access token and signs the
 * request's proof of possession. Relay negotiation and every procedure not listed are refused.
 */
export type ControlPlaneCallProcedure =
  | "device.subscribe"
  | "device.link.start"
  | "device.link.redeem"
  | "device.link.confirm"
  | "device.link.cancel"
  | "device.rename"
  | "device.revoke"
  | "device.forget"
  | "device.statement.list"
  | "device.pushAddress.update"
  | "machine.rename"
  | "machine.remove";
/**
 * The calling device's push address: its APNs token or its Web Push endpoint. Set
 * at link time and whenever the platform changes it. The control plane posts to a Web Push
 * endpoint, so that one is an `https:` address, never somewhere no push service lives.
 */
export type DevicePushAddressUpdateRequest =
  | {
      platform: "apns";
      /**
       * The token.
       */
      address: string;
    }
  | {
      platform: "webPush";
      /**
       * The endpoint.
       */
      address: string;
    };

/**
 * A machine card's facts. `This machine` is the reader's own comparison of `machineId`.
 */
export interface MachineEntry {
  /**
   * The machine.
   */
  machineId: MachineId;
  /**
   * Its name.
   */
  name: string;
  /**
   * Its platform.
   */
  platform: string;
  /**
   * Its service's version.
   */
  serviceVersion: string;
  /**
   * Whether the machine holds its relay connection now.
   */
  reachable: boolean;
  /**
   * The end of its last relay connection; `null` while it has never connected.
   */
  lastSeenAt: WireInstant | null;
}
/**
 * A device card's facts.
 */
export interface DeviceEntry {
  /**
   * The device.
   */
  deviceId: DeviceId;
  /**
   * Its name.
   */
  name: string;
  /**
   * Its platform.
   */
  platform: string;
  /**
   * Its app's version.
   */
  appVersion: string;
  /**
   * Whether the device holds a relay connection now.
   */
  connected: boolean;
  /**
   * The end of its last relay connection; `null` while it has never connected.
   */
  lastSeenAt: WireInstant | null;
  /**
   * When it was linked.
   */
  linkedAt: WireInstant;
  /**
   * Whose key linked it, so a device a since-revoked device linked is flagged.
   */
  linkedBy: TrustSigner;
  /**
   * When it was revoked; `null` while it is trusted. A revoked card sits in `Revoked`.
   */
  revokedAt: WireInstant | null;
  /**
   * The machines that have not yet fetched its revoke; each drops it when it next connects.
   */
  revokePendingOnMachineIds: MachineId[];
  /**
   * Its key kept displacing its own connection, so it is in two places at once.
   */
  seenInTwoPlaces: boolean;
}
/**
 * A passkey row's facts.
 */
export interface PasskeyEntry {
  /**
   * The passkey.
   */
  passkeyId: string;
  /**
   * The platform that holds it.
   */
  platform: string;
  /**
   * When it was added.
   */
  addedAt: WireInstant;
  /**
   * Whose key added it, so a passkey a since-revoked device added is flagged.
   */
  addedBy: TrustSigner;
}
/**
 * The list now, which the live read answers with before its first change.
 */
export interface DeviceListSnapshot {
  /**
   * The machines.
   */
  machines: MachineEntry[];
  /**
   * The devices.
   */
  devices: DeviceEntry[];
  /**
   * The passkeys.
   */
  passkeys: PasskeyEntry[];
}
/**
 * A new statement on the live read, named by its statement's kind, so a reader never meets an
 * event whose name and statement disagree.
 */
export interface DeviceStatementEvent {
  /**
   * The statement's kind.
   */
  type: TrustStatementKind;
  /**
   * The statement.
   */
  statement: TrustStatement;
}
/**
 * A single-use pairing, good for 5 minutes from when it was made.
 */
export interface DeviceLinkStartResponse {
  /**
   * The pairing.
   */
  pairingId: string;
  /**
   * When it ends.
   */
  expiresAt: WireInstant;
}
/**
 * One machine key the linking side trusts, which the six digits bind.
 */
export interface TrustedMachineKey {
  /**
   * The machine.
   */
  machineId: MachineId;
  /**
   * Its identity key.
   */
  identityKey: MachineIdentityKey;
}
/**
 * What the new device needs to show the six digits: the linking side's name and key, and the
 * machine keys it trusts.
 */
export interface DeviceLinkRedeemResponse {
  /**
   * The linking side's name.
   */
  linkingName: string;
  /**
   * The linking side's identity key.
   */
  linkingKey: IdentityPublicKey;
  /**
   * The machine keys it trusts, at least one.
   *
   * @minItems 1
   */
  machineKeys: [TrustedMachineKey, ...TrustedMachineKey[]];
}
/**
 * `It matches`: the signed `device.linked` statement for this pairing.
 */
export interface DeviceLinkConfirmRequest {
  /**
   * The pairing.
   */
  pairingId: string;
  /**
   * The statement.
   */
  statement: DeviceLinkedStatement;
}
/**
 * `Cancel`, or `It doesn't match`: the pairing ends and nothing is linked.
 */
export interface DeviceLinkCancelRequest {
  /**
   * The pairing.
   */
  pairingId: string;
}
/**
 * A rename, as the `device.renamed` statement the renaming device signs.
 */
export interface DeviceRenameRequest {
  /**
   * The statement.
   */
  statement: DeviceRenamedStatement;
}
/**
 * A revoke, as the `device.revoked` statement the revoking device signs.
 */
export interface DeviceRevokeRequest {
  /**
   * The statement.
   */
  statement: DeviceRevokedStatement;
}
/**
 * Removes a revoked device's row; its `device.revoked` stays in the chain.
 */
export interface DeviceForgetRequest {
  /**
   * The device.
   */
  deviceId: DeviceId;
}
/**
 * The chain after a given statement; `null` asks for it from the start.
 */
export interface DeviceStatementListRequest {
  /**
   * The statement to start after.
   */
  after: TrustStatementHash | null;
}
/**
 * Statements in chain order.
 */
export interface DeviceStatementListResponse {
  /**
   * The statements.
   */
  statements: TrustStatement[];
}
/**
 * Statements a device has seen, handed to a machine, which verifies each against the chain it
 * holds before it keeps it.
 */
export interface DeviceStatementApplyRequest {
  /**
   * The statements, at least one.
   *
   * @minItems 1
   */
  statements: [TrustStatement, ...TrustStatement[]];
}
/**
 * One device as this machine's verified chain sees it.
 */
export interface TrustedDevice {
  /**
   * The device.
   */
  deviceId: DeviceId;
  /**
   * Its name.
   */
  name: string;
  /**
   * Its platform.
   */
  platform: string;
  /**
   * Its identity key.
   */
  identityKey: IdentityPublicKey;
  /**
   * Its channel key.
   */
  channelKey: ChannelPublicKey;
  /**
   * The statement that trusts it.
   */
  trustedBy: TrustStatementHash;
  /**
   * When its key ended; `null` while it is trusted.
   */
  revokedAt: WireInstant | null;
}
/**
 * A machine's own verified view of the trusted devices.
 */
export interface DeviceTrustedListResponse {
  /**
   * The devices.
   */
  devices: TrustedDevice[];
}
/**
 * A Web Push subscription's own keys (RFC 8291), base64url as the browser hands them over.
 */
export interface WebPushKeys {
  /**
   * The subscription's 65-byte P-256 public key, 87 base64url characters.
   */
  p256dh: string;
  /**
   * The subscription's 16-byte authentication secret, 22 base64url characters.
   */
  auth: string;
}
/**
 * One forwarded call. `input` is the procedure's own request, which the control plane's
 * descriptor for that procedure parses, and the reply is that procedure's own result.
 */
export interface ControlPlaneCallRequest {
  /**
   * The procedure, from the closed list.
   */
  procedure: ControlPlaneCallProcedure;
  /**
   * The procedure's own request.
   */
  input: unknown;
}
/**
 * The new device's half of the link: its keys, its name and platform, and a SHA-256 HMAC under
 * the link's secret, which never reaches the control plane.
 */
export interface DeviceLinkRedeemRequest {
  /**
   * The pairing.
   */
  pairingId: string;
  /**
   * The device's identity key.
   */
  identityKey: IdentityPublicKey;
  /**
   * The device's channel key.
   */
  channelKey: ChannelPublicKey;
  /**
   * The device's name.
   */
  name: string;
  /**
   * The device's platform.
   */
  platform: string;
  /**
   * The device's app version.
   */
  appVersion: string;
  /**
   * The linking proof, a SHA-256 HMAC: 32 bytes.
   */
  mac: string;
}
/**
 * A device's own switches and push keys, handed to a machine on every connection and whenever one
 * changes. The machine keeps the copy only to decide before it sends, and never edits it.
 * `pushKey` is the 1,216-byte X-Wing public key a push is sealed to, standard base64.
 */
export interface DeviceNotificationSettingsUpdateRequest {
  /**
   * `Notify me outside the app`.
   */
  notifyOutsideTheApp: boolean;
  /**
   * `Show a count on the app icon`.
   */
  countOnAppIcon: boolean;
  /**
   * The kinds a notification is shown for.
   */
  kinds: NotificationKindSwitches;
  /**
   * The X-Wing public key a push is sealed to.
   */
  pushKey: string;
  /**
   * A browser's Web Push keys.
   */
  webPushKeys?: WebPushKeys;
}

export {
  validateControlPlaneCallProcedure,
  validateControlPlaneCallRequest,
  validateControlPlaneCallResponse,
  validateDeviceEntry,
  validateDeviceForgetRequest,
  validateDeviceLinkCancelRequest,
  validateDeviceLinkConfirmRequest,
  validateDeviceLinkRedeemRequest,
  validateDeviceLinkRedeemResponse,
  validateDeviceLinkStartResponse,
  validateDeviceListEvent,
  validateDeviceListRowEvent,
  validateDeviceListSnapshot,
  validateDeviceNotificationSettingsUpdateRequest,
  validateDevicePushAddressUpdateRequest,
  validateDeviceRenameRequest,
  validateDeviceRevokeRequest,
  validateDeviceStatementApplyRequest,
  validateDeviceStatementEvent,
  validateDeviceStatementListRequest,
  validateDeviceStatementListResponse,
  validateDeviceTrustedListResponse,
  validateMachineEntry,
  validatePasskeyEntry,
  validateTrustedDevice,
  validateTrustedMachineKey,
  validateWebPushKeys,
} from "./checks/device.js";

/** The methods of {@link DEVICE_CONTROL_PLANE_METHOD_DESCRIPTORS}, each with its checks. */
export interface DeviceControlPlaneMethodDescriptors {
  readonly "device.subscribe": {
    readonly method: "device.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DeviceListSnapshot>;
    readonly emissionCheck: SchemaCheck<DeviceListEvent>;
  };
  readonly "device.link.start": {
    readonly method: "device.link.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DeviceLinkStartResponse>;
  };
  readonly "device.link.redeem": {
    readonly method: "device.link.redeem";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceLinkRedeemRequest>;
    readonly responseCheck: SchemaCheck<DeviceLinkRedeemResponse>;
  };
  readonly "device.link.confirm": {
    readonly method: "device.link.confirm";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceLinkConfirmRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "device.link.cancel": {
    readonly method: "device.link.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceLinkCancelRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "device.rename": {
    readonly method: "device.rename";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceRenameRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "device.revoke": {
    readonly method: "device.revoke";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceRevokeRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "device.forget": {
    readonly method: "device.forget";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceForgetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "device.statement.list": {
    readonly method: "device.statement.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<DeviceStatementListRequest>;
    readonly responseCheck: SchemaCheck<DeviceStatementListResponse>;
  };
  readonly "device.pushAddress.update": {
    readonly method: "device.pushAddress.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DevicePushAddressUpdateRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The device procedures the control plane serves. */
export const DEVICE_CONTROL_PLANE_METHOD_DESCRIPTORS: DeviceControlPlaneMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "device.subscribe": /* @__PURE__ */ Object.freeze({
      method: "device.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateDeviceListSnapshot,
      emissionCheck: validateDeviceListEvent,
    }),
    "device.link.start": /* @__PURE__ */ Object.freeze({
      method: "device.link.start",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateEmptyPayload,
      responseCheck: validateDeviceLinkStartResponse,
    }),
    "device.link.redeem": /* @__PURE__ */ Object.freeze({
      method: "device.link.redeem",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceLinkRedeemRequest,
      responseCheck: validateDeviceLinkRedeemResponse,
    }),
    "device.link.confirm": /* @__PURE__ */ Object.freeze({
      method: "device.link.confirm",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceLinkConfirmRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.link.cancel": /* @__PURE__ */ Object.freeze({
      method: "device.link.cancel",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceLinkCancelRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.rename": /* @__PURE__ */ Object.freeze({
      method: "device.rename",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceRenameRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.revoke": /* @__PURE__ */ Object.freeze({
      method: "device.revoke",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceRevokeRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.forget": /* @__PURE__ */ Object.freeze({
      method: "device.forget",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceForgetRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.statement.list": /* @__PURE__ */ Object.freeze({
      method: "device.statement.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateDeviceStatementListRequest,
      responseCheck: validateDeviceStatementListResponse,
    }),
    "device.pushAddress.update": /* @__PURE__ */ Object.freeze({
      method: "device.pushAddress.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDevicePushAddressUpdateRequest,
      responseCheck: validateEmptyPayload,
    }),
  });

/** The methods of {@link DEVICE_METHOD_DESCRIPTORS}, each with its checks. */
export interface DeviceMethodDescriptors {
  readonly "device.statement.apply": {
    readonly method: "device.statement.apply";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceStatementApplyRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "device.trusted.list": {
    readonly method: "device.trusted.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DeviceTrustedListResponse>;
  };
  readonly "device.notificationSettings.update": {
    readonly method: "device.notificationSettings.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DeviceNotificationSettingsUpdateRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The device methods a machine's service answers over the channel. */
export const DEVICE_METHOD_DESCRIPTORS: DeviceMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "device.statement.apply": /* @__PURE__ */ Object.freeze({
    method: "device.statement.apply",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDeviceStatementApplyRequest,
    responseCheck: validateEmptyPayload,
  }),
  "device.trusted.list": /* @__PURE__ */ Object.freeze({
    method: "device.trusted.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDeviceTrustedListResponse,
  }),
  "device.notificationSettings.update": /* @__PURE__ */ Object.freeze({
    method: "device.notificationSettings.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDeviceNotificationSettingsUpdateRequest,
    responseCheck: validateEmptyPayload,
  }),
});

/** The methods of {@link CONTROL_PLANE_METHOD_DESCRIPTORS}, each with its checks. */
export interface ControlPlaneMethodDescriptors {
  readonly "controlPlane.call": {
    readonly method: "controlPlane.call";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ControlPlaneCallRequest>;
    readonly responseCheck: SchemaCheck<ControlPlaneCallResponse>;
  };
}
/** The one method the service answers for the window's control-plane calls. */
export const CONTROL_PLANE_METHOD_DESCRIPTORS: ControlPlaneMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "controlPlane.call": /* @__PURE__ */ Object.freeze({
      method: "controlPlane.call",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateControlPlaneCallRequest,
      responseCheck: validateControlPlaneCallResponse,
    }),
  });
