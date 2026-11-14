// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The device requests: list, link, rename, revoke, forget, push address, notification switches, and the desktop's control-plane calls through the background service.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  type SchemaCheck,
  deepEqual,
  ucs2length,
} from "../schema-check.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import { type MachineId, validateMachineId } from "./machine/id.js";
import {
  type NotificationKindSwitches,
  validateNotificationKindSwitches,
} from "./machine/settings.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import {
  type ChannelPublicKey,
  type DeviceId,
  type DeviceLinkedStatement,
  type DeviceRenamedStatement,
  type DeviceRevokedStatement,
  type IdentityPublicKey,
  type MachineIdentityKey,
  type TrustSigner,
  type TrustStatement,
  type TrustStatementHash,
  type TrustStatementKind,
  validateChannelPublicKey,
  validateDeviceId,
  validateDeviceLinkedStatement,
  validateDeviceRenamedStatement,
  validateDeviceRevokedStatement,
  validateIdentityPublicKey,
  validateMachineIdentityKey,
  validateTrustSigner,
  validateTrustStatement,
  validateTrustStatementHash,
  validateTrustStatementKind,
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

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link MachineEntry}. */
// prettier-ignore
export const validateMachineEntry: CompiledSchemaCheck<MachineEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMachineEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.platform === undefined) && (missing0 = "platform"))) || ((data.serviceVersion === undefined) && (missing0 = "serviceVersion"))) || ((data.reachable === undefined) && (missing0 = "reachable"))) || ((data.lastSeenAt === undefined) && (missing0 = "lastSeenAt"))){validateMachineEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "machineId") || (key0 === "name")) || (key0 === "platform")) || (key0 === "serviceVersion")) || (key0 === "reachable")) || (key0 === "lastSeenAt"))){validateMachineEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){const _errs2: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateMachineEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateMachineEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateMachineEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateMachineEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.platform !== undefined){let data2: any = data.platform;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validateMachineEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validateMachineEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateMachineEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateMachineEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.serviceVersion !== undefined){let data3: any = data.serviceVersion;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) > 64){validateMachineEntry.errors = [{instancePath:instancePath+"/serviceVersion",schemaPath:"#/properties/serviceVersion/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(func1(data3) < 1){validateMachineEntry.errors = [{instancePath:instancePath+"/serviceVersion",schemaPath:"#/properties/serviceVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateMachineEntry.errors = [{instancePath:instancePath+"/serviceVersion",schemaPath:"#/properties/serviceVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateMachineEntry.errors = [{instancePath:instancePath+"/serviceVersion",schemaPath:"#/properties/serviceVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.reachable !== undefined){const _errs9: any = errors;if(typeof data.reachable !== "boolean"){validateMachineEntry.errors = [{instancePath:instancePath+"/reachable",schemaPath:"#/properties/reachable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastSeenAt !== undefined){let data5: any = data.lastSeenAt;const _errs11: any = errors;const _errs12: any = errors;let valid1: any = false;const _errs13: any = errors;if(!(validateWireInstant.call(this, data5, {instancePath:instancePath+"/lastSeenAt",parentData:data,parentDataProperty:"lastSeenAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var _valid0: any = _errs13 === errors;valid1 = valid1 || _valid0;const _errs14: any = errors;if(data5 !== null){const err0: any = {instancePath:instancePath+"/lastSeenAt",schemaPath:"#/properties/lastSeenAt/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs14 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/lastSeenAt",schemaPath:"#/properties/lastSeenAt/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateMachineEntry.errors = vErrors;return false;}else {errors = _errs12;if(vErrors !== null){if(_errs12){vErrors.length = _errs12;}else {vErrors = null;}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateMachineEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateMachineEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateMachineEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema26: any = {"type":"object","additionalProperties":false,"properties":{"deviceId":{"$ref":"sidekicks-contracts:trust-statement#/$defs/DeviceId","description":"The device."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Its name."},"platform":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"Its platform."},"appVersion":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":64,"description":"Its app's version."},"connected":{"type":"boolean","description":"Whether the device holds a relay connection now."},"lastSeenAt":{"anyOf":[{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant"},{"type":"null"}],"description":"The end of its last relay connection; `null` while it has never connected."},"linkedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was linked."},"linkedBy":{"$ref":"sidekicks-contracts:trust-statement#/$defs/TrustSigner","description":"Whose key linked it, so a device a since-revoked device linked is flagged."},"revokedAt":{"anyOf":[{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant"},{"type":"null"}],"description":"When it was revoked; `null` while it is trusted. A revoked card sits in `Revoked`."},"revokePendingOnMachineIds":{"type":"array","items":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId"},"description":"The machines that have not yet fetched its revoke; each drops it when it next connects."},"seenInTwoPlaces":{"type":"boolean","description":"Its key kept displacing its own connection, so it is in two places at once."}},"required":["deviceId","name","platform","appVersion","connected","lastSeenAt","linkedAt","linkedBy","revokedAt","revokePendingOnMachineIds","seenInTwoPlaces"],"description":"A device card's facts."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern10 = new RegExp("^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$", "u");
/** Checks that a value is a {@link DeviceEntry}. */
// prettier-ignore
export const validateDeviceEntry: CompiledSchemaCheck<DeviceEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((data.deviceId === undefined) && (missing0 = "deviceId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.platform === undefined) && (missing0 = "platform"))) || ((data.appVersion === undefined) && (missing0 = "appVersion"))) || ((data.connected === undefined) && (missing0 = "connected"))) || ((data.lastSeenAt === undefined) && (missing0 = "lastSeenAt"))) || ((data.linkedAt === undefined) && (missing0 = "linkedAt"))) || ((data.linkedBy === undefined) && (missing0 = "linkedBy"))) || ((data.revokedAt === undefined) && (missing0 = "revokedAt"))) || ((data.revokePendingOnMachineIds === undefined) && (missing0 = "revokePendingOnMachineIds"))) || ((data.seenInTwoPlaces === undefined) && (missing0 = "seenInTwoPlaces"))){validateDeviceEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema26.properties, key0))){validateDeviceEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deviceId !== undefined){const _errs2: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateDeviceEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateDeviceEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateDeviceEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.platform !== undefined){let data2: any = data.platform;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validateDeviceEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validateDeviceEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateDeviceEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVersion !== undefined){let data3: any = data.appVersion;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) > 64){validateDeviceEntry.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(func1(data3) < 1){validateDeviceEntry.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateDeviceEntry.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceEntry.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.connected !== undefined){const _errs9: any = errors;if(typeof data.connected !== "boolean"){validateDeviceEntry.errors = [{instancePath:instancePath+"/connected",schemaPath:"#/properties/connected/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastSeenAt !== undefined){let data5: any = data.lastSeenAt;const _errs11: any = errors;const _errs12: any = errors;let valid1: any = false;const _errs13: any = errors;if(!(validateWireInstant.call(this, data5, {instancePath:instancePath+"/lastSeenAt",parentData:data,parentDataProperty:"lastSeenAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var _valid0: any = _errs13 === errors;valid1 = valid1 || _valid0;const _errs14: any = errors;if(data5 !== null){const err0: any = {instancePath:instancePath+"/lastSeenAt",schemaPath:"#/properties/lastSeenAt/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs14 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/lastSeenAt",schemaPath:"#/properties/lastSeenAt/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateDeviceEntry.errors = vErrors;return false;}else {errors = _errs12;if(vErrors !== null){if(_errs12){vErrors.length = _errs12;}else {vErrors = null;}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.linkedAt !== undefined){const _errs16: any = errors;if(!(validateWireInstant.call(this, data.linkedAt, {instancePath:instancePath+"/linkedAt",parentData:data,parentDataProperty:"linkedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.linkedBy !== undefined){const _errs17: any = errors;if(!(validateTrustSigner.call(this, data.linkedBy, {instancePath:instancePath+"/linkedBy",parentData:data,parentDataProperty:"linkedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustSigner.errors : vErrors.concat(validateTrustSigner.errors);errors = vErrors.length;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.revokedAt !== undefined){let data8: any = data.revokedAt;const _errs18: any = errors;const _errs19: any = errors;let valid2: any = false;const _errs20: any = errors;if(!(validateWireInstant.call(this, data8, {instancePath:instancePath+"/revokedAt",parentData:data,parentDataProperty:"revokedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var _valid1: any = _errs20 === errors;valid2 = valid2 || _valid1;const _errs21: any = errors;if(data8 !== null){const err2: any = {instancePath:instancePath+"/revokedAt",schemaPath:"#/properties/revokedAt/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs21 === errors;valid2 = valid2 || _valid1;if(!valid2){const err3: any = {instancePath:instancePath+"/revokedAt",schemaPath:"#/properties/revokedAt/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateDeviceEntry.errors = vErrors;return false;}else {errors = _errs19;if(vErrors !== null){if(_errs19){vErrors.length = _errs19;}else {vErrors = null;}}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.revokePendingOnMachineIds !== undefined){let data9: any = data.revokePendingOnMachineIds;const _errs23: any = errors;if(errors === _errs23){if(Array.isArray(data9)){var valid3: any = true;const len0: any = data9.length;for(let i0=0; i0<len0; i0++){const _errs25: any = errors;if(!(validateMachineId.call(this, data9[i0], {instancePath:instancePath+"/revokePendingOnMachineIds/" + i0,parentData:data9,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid3: any = _errs25 === errors;if(!valid3){break;}}}else {validateDeviceEntry.errors = [{instancePath:instancePath+"/revokePendingOnMachineIds",schemaPath:"#/properties/revokePendingOnMachineIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.seenInTwoPlaces !== undefined){const _errs26: any = errors;if(typeof data.seenInTwoPlaces !== "boolean"){validateDeviceEntry.errors = [{instancePath:instancePath+"/seenInTwoPlaces",schemaPath:"#/properties/seenInTwoPlaces/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs26 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}else {validateDeviceEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PasskeyEntry}. */
// prettier-ignore
export const validatePasskeyEntry: CompiledSchemaCheck<PasskeyEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PasskeyEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePasskeyEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.passkeyId === undefined) && (missing0 = "passkeyId")) || ((data.platform === undefined) && (missing0 = "platform"))) || ((data.addedAt === undefined) && (missing0 = "addedAt"))) || ((data.addedBy === undefined) && (missing0 = "addedBy"))){validatePasskeyEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "passkeyId") || (key0 === "platform")) || (key0 === "addedAt")) || (key0 === "addedBy"))){validatePasskeyEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.passkeyId !== undefined){let data0: any = data.passkeyId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validatePasskeyEntry.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validatePasskeyEntry.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validatePasskeyEntry.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validatePasskeyEntry.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.platform !== undefined){let data1: any = data.platform;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 128){validatePasskeyEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validatePasskeyEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validatePasskeyEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePasskeyEntry.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.addedAt !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.addedAt, {instancePath:instancePath+"/addedAt",parentData:data,parentDataProperty:"addedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.addedBy !== undefined){const _errs7: any = errors;if(!(validateTrustSigner.call(this, data.addedBy, {instancePath:instancePath+"/addedBy",parentData:data,parentDataProperty:"addedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustSigner.errors : vErrors.concat(validateTrustSigner.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validatePasskeyEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePasskeyEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePasskeyEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceListSnapshot}. */
// prettier-ignore
export const validateDeviceListSnapshot: CompiledSchemaCheck<DeviceListSnapshot> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceListSnapshot {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceListSnapshot.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.machines === undefined) && (missing0 = "machines")) || ((data.devices === undefined) && (missing0 = "devices"))) || ((data.passkeys === undefined) && (missing0 = "passkeys"))){validateDeviceListSnapshot.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "machines") || (key0 === "devices")) || (key0 === "passkeys"))){validateDeviceListSnapshot.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machines !== undefined){let data0: any = data.machines;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateMachineEntry.call(this, data0[i0], {instancePath:instancePath+"/machines/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineEntry.errors : vErrors.concat(validateMachineEntry.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateDeviceListSnapshot.errors = [{instancePath:instancePath+"/machines",schemaPath:"#/properties/machines/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.devices !== undefined){let data2: any = data.devices;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data2)){var valid2: any = true;const len1: any = data2.length;for(let i1=0; i1<len1; i1++){const _errs7: any = errors;if(!(validateDeviceEntry.call(this, data2[i1], {instancePath:instancePath+"/devices/" + i1,parentData:data2,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceEntry.errors : vErrors.concat(validateDeviceEntry.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {validateDeviceListSnapshot.errors = [{instancePath:instancePath+"/devices",schemaPath:"#/properties/devices/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.passkeys !== undefined){let data4: any = data.passkeys;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data4)){var valid3: any = true;const len2: any = data4.length;for(let i2=0; i2<len2; i2++){const _errs10: any = errors;if(!(validatePasskeyEntry.call(this, data4[i2], {instancePath:instancePath+"/passkeys/" + i2,parentData:data4,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePasskeyEntry.errors : vErrors.concat(validatePasskeyEntry.errors);errors = vErrors.length;}var valid3: any = _errs10 === errors;if(!valid3){break;}}}else {validateDeviceListSnapshot.errors = [{instancePath:instancePath+"/passkeys",schemaPath:"#/properties/passkeys/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validateDeviceListSnapshot.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceListSnapshot.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceListSnapshot.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern165 = new RegExp("^[A-Za-z0-9+/]{43}=$", "u");
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link DeviceStatementEvent}. */
// prettier-ignore
export const validateDeviceStatementEvent: CompiledSchemaCheck<DeviceStatementEvent> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceStatementEvent {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceStatementEvent.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.type === undefined) && (missing0 = "type")) || ((data.statement === undefined) && (missing0 = "statement"))){validateDeviceStatementEvent.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "type") || (key0 === "statement"))){validateDeviceStatementEvent.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs2: any = errors;if(!(validateTrustStatementKind.call(this, data0, {instancePath:instancePath+"/type",parentData:data,parentDataProperty:"type",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementKind.errors : vErrors.concat(validateTrustStatementKind.errors);errors = vErrors.length;}else {const vSchema0: any = data && data.statement && data.statement.kind;if(vSchema0 !== undefined && (!func0(data0, vSchema0))){validateDeviceStatementEvent.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/const",keyword:"const",params:{allowedValue: vSchema0}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.statement !== undefined){const _errs3: any = errors;if(!(validateTrustStatement.call(this, data.statement, {instancePath:instancePath+"/statement",parentData:data,parentDataProperty:"statement",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatement.errors : vErrors.concat(validateTrustStatement.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateDeviceStatementEvent.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceStatementEvent.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceStatementEvent.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceListRowEvent}. */
// prettier-ignore
export const validateDeviceListRowEvent: CompiledSchemaCheck<DeviceListRowEvent> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceListRowEvent {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceListRowEvent.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.type;if(typeof tag0 == "string"){if(tag0 === "device.forgotten"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.type === undefined) && (missing0 = "type")) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "type") || (key0 === "deviceId"))){validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs5: any = errors;if(typeof data0 !== "string"){validateDeviceListRowEvent.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("device.forgotten" !== data0){validateDeviceListRowEvent.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "device.forgotten"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){const _errs7: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "machine.registered"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.type === undefined) && (missing1 = "type")) || ((data.machine === undefined) && (missing1 = "machine"))){validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!((key1 === "type") || (key1 === "machine"))){validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.type !== undefined){let data2: any = data.type;const _errs11: any = errors;if(typeof data2 !== "string"){validateDeviceListRowEvent.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("machine.registered" !== data2){validateDeviceListRowEvent.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "machine.registered"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.machine !== undefined){const _errs13: any = errors;if(!(validateMachineEntry.call(this, data.machine, {instancePath:instancePath+"/machine",parentData:data,parentDataProperty:"machine",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineEntry.errors : vErrors.concat(validateMachineEntry.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}}}}}else {validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag0}}];return false;}}else {validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateDeviceListRowEvent.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceListRowEvent.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceListRowEvent.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceListEvent}. */
// prettier-ignore
export const validateDeviceListEvent: CompiledSchemaCheck<DeviceListEvent> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceListEvent {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceListEvent.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateDeviceStatementEvent.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceStatementEvent.errors : vErrors.concat(validateDeviceStatementEvent.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateDeviceListRowEvent.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceListRowEvent.errors : vErrors.concat(validateDeviceListRowEvent.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateDeviceListEvent.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateDeviceListEvent.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateDeviceListEvent.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceLinkStartResponse}. */
// prettier-ignore
export const validateDeviceLinkStartResponse: CompiledSchemaCheck<DeviceLinkStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceLinkStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceLinkStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pairingId === undefined) && (missing0 = "pairingId")) || ((data.expiresAt === undefined) && (missing0 = "expiresAt"))){validateDeviceLinkStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pairingId") || (key0 === "expiresAt"))){validateDeviceLinkStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pairingId !== undefined){let data0: any = data.pairingId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateDeviceLinkStartResponse.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateDeviceLinkStartResponse.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateDeviceLinkStartResponse.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkStartResponse.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.expiresAt !== undefined){const _errs4: any = errors;if(!(validateWireInstant.call(this, data.expiresAt, {instancePath:instancePath+"/expiresAt",parentData:data,parentDataProperty:"expiresAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateDeviceLinkStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceLinkStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceLinkStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TrustedMachineKey}. */
// prettier-ignore
export const validateTrustedMachineKey: CompiledSchemaCheck<TrustedMachineKey> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustedMachineKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTrustedMachineKey.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.machineId === undefined) && (missing0 = "machineId")) || ((data.identityKey === undefined) && (missing0 = "identityKey"))){validateTrustedMachineKey.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "machineId") || (key0 === "identityKey"))){validateTrustedMachineKey.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){const _errs2: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.identityKey !== undefined){const _errs3: any = errors;if(!(validateMachineIdentityKey.call(this, data.identityKey, {instancePath:instancePath+"/identityKey",parentData:data,parentDataProperty:"identityKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineIdentityKey.errors : vErrors.concat(validateMachineIdentityKey.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateTrustedMachineKey.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTrustedMachineKey.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTrustedMachineKey.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceLinkRedeemResponse}. */
// prettier-ignore
export const validateDeviceLinkRedeemResponse: CompiledSchemaCheck<DeviceLinkRedeemResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceLinkRedeemResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceLinkRedeemResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.linkingName === undefined) && (missing0 = "linkingName")) || ((data.linkingKey === undefined) && (missing0 = "linkingKey"))) || ((data.machineKeys === undefined) && (missing0 = "machineKeys"))){validateDeviceLinkRedeemResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "linkingName") || (key0 === "linkingKey")) || (key0 === "machineKeys"))){validateDeviceLinkRedeemResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.linkingName !== undefined){let data0: any = data.linkingName;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateDeviceLinkRedeemResponse.errors = [{instancePath:instancePath+"/linkingName",schemaPath:"#/properties/linkingName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateDeviceLinkRedeemResponse.errors = [{instancePath:instancePath+"/linkingName",schemaPath:"#/properties/linkingName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateDeviceLinkRedeemResponse.errors = [{instancePath:instancePath+"/linkingName",schemaPath:"#/properties/linkingName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkRedeemResponse.errors = [{instancePath:instancePath+"/linkingName",schemaPath:"#/properties/linkingName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.linkingKey !== undefined){const _errs4: any = errors;if(!(validateIdentityPublicKey.call(this, data.linkingKey, {instancePath:instancePath+"/linkingKey",parentData:data,parentDataProperty:"linkingKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateIdentityPublicKey.errors : vErrors.concat(validateIdentityPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.machineKeys !== undefined){let data2: any = data.machineKeys;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data2)){if(data2.length < 1){validateDeviceLinkRedeemResponse.errors = [{instancePath:instancePath+"/machineKeys",schemaPath:"#/properties/machineKeys/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validateTrustedMachineKey.call(this, data2[i0], {instancePath:instancePath+"/machineKeys/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustedMachineKey.errors : vErrors.concat(validateTrustedMachineKey.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;if(!valid1){break;}}}}else {validateDeviceLinkRedeemResponse.errors = [{instancePath:instancePath+"/machineKeys",schemaPath:"#/properties/machineKeys/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateDeviceLinkRedeemResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceLinkRedeemResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceLinkRedeemResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceLinkConfirmRequest}. */
// prettier-ignore
export const validateDeviceLinkConfirmRequest: CompiledSchemaCheck<DeviceLinkConfirmRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceLinkConfirmRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceLinkConfirmRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pairingId === undefined) && (missing0 = "pairingId")) || ((data.statement === undefined) && (missing0 = "statement"))){validateDeviceLinkConfirmRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pairingId") || (key0 === "statement"))){validateDeviceLinkConfirmRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pairingId !== undefined){let data0: any = data.pairingId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateDeviceLinkConfirmRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateDeviceLinkConfirmRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateDeviceLinkConfirmRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkConfirmRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.statement !== undefined){const _errs4: any = errors;if(!(validateDeviceLinkedStatement.call(this, data.statement, {instancePath:instancePath+"/statement",parentData:data,parentDataProperty:"statement",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceLinkedStatement.errors : vErrors.concat(validateDeviceLinkedStatement.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateDeviceLinkConfirmRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceLinkConfirmRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceLinkConfirmRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceLinkCancelRequest}. */
// prettier-ignore
export const validateDeviceLinkCancelRequest: CompiledSchemaCheck<DeviceLinkCancelRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceLinkCancelRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceLinkCancelRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.pairingId === undefined) && (missing0 = "pairingId")){validateDeviceLinkCancelRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "pairingId")){validateDeviceLinkCancelRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pairingId !== undefined){let data0: any = data.pairingId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateDeviceLinkCancelRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateDeviceLinkCancelRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateDeviceLinkCancelRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkCancelRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateDeviceLinkCancelRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceLinkCancelRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceLinkCancelRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceRenameRequest}. */
// prettier-ignore
export const validateDeviceRenameRequest: CompiledSchemaCheck<DeviceRenameRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceRenameRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceRenameRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.statement === undefined) && (missing0 = "statement")){validateDeviceRenameRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "statement")){validateDeviceRenameRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.statement !== undefined){if(!(validateDeviceRenamedStatement.call(this, data.statement, {instancePath:instancePath+"/statement",parentData:data,parentDataProperty:"statement",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceRenamedStatement.errors : vErrors.concat(validateDeviceRenamedStatement.errors);errors = vErrors.length;}}}}}else {validateDeviceRenameRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceRenameRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceRenameRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceRevokeRequest}. */
// prettier-ignore
export const validateDeviceRevokeRequest: CompiledSchemaCheck<DeviceRevokeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceRevokeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceRevokeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.statement === undefined) && (missing0 = "statement")){validateDeviceRevokeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "statement")){validateDeviceRevokeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.statement !== undefined){if(!(validateDeviceRevokedStatement.call(this, data.statement, {instancePath:instancePath+"/statement",parentData:data,parentDataProperty:"statement",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceRevokedStatement.errors : vErrors.concat(validateDeviceRevokedStatement.errors);errors = vErrors.length;}}}}}else {validateDeviceRevokeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceRevokeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceRevokeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceForgetRequest}. */
// prettier-ignore
export const validateDeviceForgetRequest: CompiledSchemaCheck<DeviceForgetRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceForgetRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceForgetRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.deviceId === undefined) && (missing0 = "deviceId")){validateDeviceForgetRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "deviceId")){validateDeviceForgetRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deviceId !== undefined){if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}}}}}else {validateDeviceForgetRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceForgetRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceForgetRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceStatementListRequest}. */
// prettier-ignore
export const validateDeviceStatementListRequest: CompiledSchemaCheck<DeviceStatementListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceStatementListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceStatementListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.after === undefined) && (missing0 = "after")){validateDeviceStatementListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "after")){validateDeviceStatementListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.after !== undefined){let data0: any = data.after;const _errs3: any = errors;let valid1: any = false;const _errs4: any = errors;if(!(validateTrustStatementHash.call(this, data0, {instancePath:instancePath+"/after",parentData:data,parentDataProperty:"after",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var _valid0: any = _errs4 === errors;valid1 = valid1 || _valid0;const _errs5: any = errors;if(data0 !== null){const err0: any = {instancePath:instancePath+"/after",schemaPath:"#/properties/after/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs5 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/after",schemaPath:"#/properties/after/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateDeviceStatementListRequest.errors = vErrors;return false;}else {errors = _errs3;if(vErrors !== null){if(_errs3){vErrors.length = _errs3;}else {vErrors = null;}}}}}}}else {validateDeviceStatementListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceStatementListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceStatementListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceStatementListResponse}. */
// prettier-ignore
export const validateDeviceStatementListResponse: CompiledSchemaCheck<DeviceStatementListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceStatementListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceStatementListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.statements === undefined) && (missing0 = "statements")){validateDeviceStatementListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "statements")){validateDeviceStatementListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.statements !== undefined){let data0: any = data.statements;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateTrustStatement.call(this, data0[i0], {instancePath:instancePath+"/statements/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatement.errors : vErrors.concat(validateTrustStatement.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateDeviceStatementListResponse.errors = [{instancePath:instancePath+"/statements",schemaPath:"#/properties/statements/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateDeviceStatementListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceStatementListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceStatementListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceStatementApplyRequest}. */
// prettier-ignore
export const validateDeviceStatementApplyRequest: CompiledSchemaCheck<DeviceStatementApplyRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceStatementApplyRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceStatementApplyRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.statements === undefined) && (missing0 = "statements")){validateDeviceStatementApplyRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "statements")){validateDeviceStatementApplyRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.statements !== undefined){let data0: any = data.statements;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length < 1){validateDeviceStatementApplyRequest.errors = [{instancePath:instancePath+"/statements",schemaPath:"#/properties/statements/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateTrustStatement.call(this, data0[i0], {instancePath:instancePath+"/statements/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatement.errors : vErrors.concat(validateTrustStatement.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}else {validateDeviceStatementApplyRequest.errors = [{instancePath:instancePath+"/statements",schemaPath:"#/properties/statements/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateDeviceStatementApplyRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceStatementApplyRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceStatementApplyRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TrustedDevice}. */
// prettier-ignore
export const validateTrustedDevice: CompiledSchemaCheck<TrustedDevice> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustedDevice {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTrustedDevice.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.deviceId === undefined) && (missing0 = "deviceId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.platform === undefined) && (missing0 = "platform"))) || ((data.identityKey === undefined) && (missing0 = "identityKey"))) || ((data.channelKey === undefined) && (missing0 = "channelKey"))) || ((data.trustedBy === undefined) && (missing0 = "trustedBy"))) || ((data.revokedAt === undefined) && (missing0 = "revokedAt"))){validateTrustedDevice.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "deviceId") || (key0 === "name")) || (key0 === "platform")) || (key0 === "identityKey")) || (key0 === "channelKey")) || (key0 === "trustedBy")) || (key0 === "revokedAt"))){validateTrustedDevice.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deviceId !== undefined){const _errs2: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateTrustedDevice.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateTrustedDevice.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateTrustedDevice.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustedDevice.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.platform !== undefined){let data2: any = data.platform;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validateTrustedDevice.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validateTrustedDevice.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateTrustedDevice.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustedDevice.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.identityKey !== undefined){const _errs7: any = errors;if(!(validateIdentityPublicKey.call(this, data.identityKey, {instancePath:instancePath+"/identityKey",parentData:data,parentDataProperty:"identityKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateIdentityPublicKey.errors : vErrors.concat(validateIdentityPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.channelKey !== undefined){const _errs8: any = errors;if(!(validateChannelPublicKey.call(this, data.channelKey, {instancePath:instancePath+"/channelKey",parentData:data,parentDataProperty:"channelKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChannelPublicKey.errors : vErrors.concat(validateChannelPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.trustedBy !== undefined){const _errs9: any = errors;if(!(validateTrustStatementHash.call(this, data.trustedBy, {instancePath:instancePath+"/trustedBy",parentData:data,parentDataProperty:"trustedBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.revokedAt !== undefined){let data6: any = data.revokedAt;const _errs10: any = errors;const _errs11: any = errors;let valid1: any = false;const _errs12: any = errors;if(!(validateWireInstant.call(this, data6, {instancePath:instancePath+"/revokedAt",parentData:data,parentDataProperty:"revokedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var _valid0: any = _errs12 === errors;valid1 = valid1 || _valid0;const _errs13: any = errors;if(data6 !== null){const err0: any = {instancePath:instancePath+"/revokedAt",schemaPath:"#/properties/revokedAt/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs13 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/revokedAt",schemaPath:"#/properties/revokedAt/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateTrustedDevice.errors = vErrors;return false;}else {errors = _errs11;if(vErrors !== null){if(_errs11){vErrors.length = _errs11;}else {vErrors = null;}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateTrustedDevice.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTrustedDevice.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTrustedDevice.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceTrustedListResponse}. */
// prettier-ignore
export const validateDeviceTrustedListResponse: CompiledSchemaCheck<DeviceTrustedListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceTrustedListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceTrustedListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.devices === undefined) && (missing0 = "devices")){validateDeviceTrustedListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "devices")){validateDeviceTrustedListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.devices !== undefined){let data0: any = data.devices;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateTrustedDevice.call(this, data0[i0], {instancePath:instancePath+"/devices/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustedDevice.errors : vErrors.concat(validateTrustedDevice.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateDeviceTrustedListResponse.errors = [{instancePath:instancePath+"/devices",schemaPath:"#/properties/devices/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateDeviceTrustedListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceTrustedListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceTrustedListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ControlPlaneCallResponse}. */
// prettier-ignore
export const validateControlPlaneCallResponse: CompiledSchemaCheck<ControlPlaneCallResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ControlPlaneCallResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateControlPlaneCallResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}validateControlPlaneCallResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateControlPlaneCallResponse.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WebPushKeys}. */
// prettier-ignore
export const validateWebPushKeys: CompiledSchemaCheck<WebPushKeys> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebPushKeys {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebPushKeys.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.p256dh === undefined) && (missing0 = "p256dh")) || ((data.auth === undefined) && (missing0 = "auth"))){validateWebPushKeys.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "p256dh") || (key0 === "auth"))){validateWebPushKeys.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.p256dh !== undefined){let data0: any = data.p256dh;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 87){validateWebPushKeys.errors = [{instancePath:instancePath+"/p256dh",schemaPath:"#/properties/p256dh/maxLength",keyword:"maxLength",params:{limit: 87}}];return false;}else {if(func1(data0) < 87){validateWebPushKeys.errors = [{instancePath:instancePath+"/p256dh",schemaPath:"#/properties/p256dh/minLength",keyword:"minLength",params:{limit: 87}}];return false;}else {if(!pattern10.test(data0)){validateWebPushKeys.errors = [{instancePath:instancePath+"/p256dh",schemaPath:"#/properties/p256dh/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateWebPushKeys.errors = [{instancePath:instancePath+"/p256dh",schemaPath:"#/properties/p256dh/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.auth !== undefined){let data1: any = data.auth;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 22){validateWebPushKeys.errors = [{instancePath:instancePath+"/auth",schemaPath:"#/properties/auth/maxLength",keyword:"maxLength",params:{limit: 22}}];return false;}else {if(func1(data1) < 22){validateWebPushKeys.errors = [{instancePath:instancePath+"/auth",schemaPath:"#/properties/auth/minLength",keyword:"minLength",params:{limit: 22}}];return false;}else {if(!pattern10.test(data1)){validateWebPushKeys.errors = [{instancePath:instancePath+"/auth",schemaPath:"#/properties/auth/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateWebPushKeys.errors = [{instancePath:instancePath+"/auth",schemaPath:"#/properties/auth/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateWebPushKeys.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebPushKeys.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebPushKeys.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema312: any = {"description":"The control-plane procedures the desktop's screens call. The window holds no credential, so\neach rides the background service, which attaches the account's access token and signs the\nrequest's proof of possession. Relay negotiation and every procedure not listed are refused.","type":"string","enum":["device.subscribe","device.link.start","device.link.redeem","device.link.confirm","device.link.cancel","device.rename","device.revoke","device.forget","device.statement.list","device.pushAddress.update","machine.rename","machine.remove"]};
/** Checks that a value is a {@link ControlPlaneCallProcedure}. */
// prettier-ignore
export const validateControlPlaneCallProcedure: CompiledSchemaCheck<ControlPlaneCallProcedure> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ControlPlaneCallProcedure {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateControlPlaneCallProcedure.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateControlPlaneCallProcedure.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((((((((data === "device.subscribe") || (data === "device.link.start")) || (data === "device.link.redeem")) || (data === "device.link.confirm")) || (data === "device.link.cancel")) || (data === "device.rename")) || (data === "device.revoke")) || (data === "device.forget")) || (data === "device.statement.list")) || (data === "device.pushAddress.update")) || (data === "machine.rename")) || (data === "machine.remove"))){validateControlPlaneCallProcedure.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema312.enum}}];return false;}validateControlPlaneCallProcedure.errors = vErrors;return errors === 0;};
// prettier-ignore
validateControlPlaneCallProcedure.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ControlPlaneCallRequest}. */
// prettier-ignore
export const validateControlPlaneCallRequest: CompiledSchemaCheck<ControlPlaneCallRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ControlPlaneCallRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateControlPlaneCallRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.procedure === undefined) && (missing0 = "procedure")) || ((data.input === undefined) && (missing0 = "input"))){validateControlPlaneCallRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "procedure") || (key0 === "input"))){validateControlPlaneCallRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.procedure !== undefined){const _errs2: any = errors;if(!(validateControlPlaneCallProcedure.call(this, data.procedure, {instancePath:instancePath+"/procedure",parentData:data,parentDataProperty:"procedure",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateControlPlaneCallProcedure.errors : vErrors.concat(validateControlPlaneCallProcedure.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.input !== undefined){const _errs3: any = errors;var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateControlPlaneCallRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateControlPlaneCallRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateControlPlaneCallRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeviceLinkRedeemRequest}. */
// prettier-ignore
export const validateDeviceLinkRedeemRequest: CompiledSchemaCheck<DeviceLinkRedeemRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceLinkRedeemRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceLinkRedeemRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.pairingId === undefined) && (missing0 = "pairingId")) || ((data.identityKey === undefined) && (missing0 = "identityKey"))) || ((data.channelKey === undefined) && (missing0 = "channelKey"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.platform === undefined) && (missing0 = "platform"))) || ((data.appVersion === undefined) && (missing0 = "appVersion"))) || ((data.mac === undefined) && (missing0 = "mac"))){validateDeviceLinkRedeemRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "pairingId") || (key0 === "identityKey")) || (key0 === "channelKey")) || (key0 === "name")) || (key0 === "platform")) || (key0 === "appVersion")) || (key0 === "mac"))){validateDeviceLinkRedeemRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pairingId !== undefined){let data0: any = data.pairingId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/pairingId",schemaPath:"#/properties/pairingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.identityKey !== undefined){const _errs4: any = errors;if(!(validateIdentityPublicKey.call(this, data.identityKey, {instancePath:instancePath+"/identityKey",parentData:data,parentDataProperty:"identityKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateIdentityPublicKey.errors : vErrors.concat(validateIdentityPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.channelKey !== undefined){const _errs5: any = errors;if(!(validateChannelPublicKey.call(this, data.channelKey, {instancePath:instancePath+"/channelKey",parentData:data,parentDataProperty:"channelKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChannelPublicKey.errors : vErrors.concat(validateChannelPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data3: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) > 256){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.platform !== undefined){let data4: any = data.platform;const _errs8: any = errors;if(errors === _errs8){if(typeof data4 === "string"){if(func1(data4) > 128){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.appVersion !== undefined){let data5: any = data.appVersion;const _errs10: any = errors;if(errors === _errs10){if(typeof data5 === "string"){if(func1(data5) > 64){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(func1(data5) < 1){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/appVersion",schemaPath:"#/properties/appVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.mac !== undefined){let data6: any = data.mac;const _errs12: any = errors;if(errors === _errs12){if(typeof data6 === "string"){if(!pattern165.test(data6)){validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/mac",schemaPath:"#/properties/mac/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validateDeviceLinkRedeemRequest.errors = [{instancePath:instancePath+"/mac",schemaPath:"#/properties/mac/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateDeviceLinkRedeemRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceLinkRedeemRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceLinkRedeemRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern191 = new RegExp("^[A-Za-z0-9+/]{1622}==$", "u");
/** Checks that a value is a {@link DeviceNotificationSettingsUpdateRequest}. */
// prettier-ignore
export const validateDeviceNotificationSettingsUpdateRequest: CompiledSchemaCheck<DeviceNotificationSettingsUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceNotificationSettingsUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceNotificationSettingsUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.notifyOutsideTheApp === undefined) && (missing0 = "notifyOutsideTheApp")) || ((data.countOnAppIcon === undefined) && (missing0 = "countOnAppIcon"))) || ((data.kinds === undefined) && (missing0 = "kinds"))) || ((data.pushKey === undefined) && (missing0 = "pushKey"))){validateDeviceNotificationSettingsUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "notifyOutsideTheApp") || (key0 === "countOnAppIcon")) || (key0 === "kinds")) || (key0 === "pushKey")) || (key0 === "webPushKeys"))){validateDeviceNotificationSettingsUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.notifyOutsideTheApp !== undefined){const _errs2: any = errors;if(typeof data.notifyOutsideTheApp !== "boolean"){validateDeviceNotificationSettingsUpdateRequest.errors = [{instancePath:instancePath+"/notifyOutsideTheApp",schemaPath:"#/properties/notifyOutsideTheApp/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.countOnAppIcon !== undefined){const _errs4: any = errors;if(typeof data.countOnAppIcon !== "boolean"){validateDeviceNotificationSettingsUpdateRequest.errors = [{instancePath:instancePath+"/countOnAppIcon",schemaPath:"#/properties/countOnAppIcon/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.kinds !== undefined){const _errs6: any = errors;if(!(validateNotificationKindSwitches.call(this, data.kinds, {instancePath:instancePath+"/kinds",parentData:data,parentDataProperty:"kinds",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateNotificationKindSwitches.errors : vErrors.concat(validateNotificationKindSwitches.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.pushKey !== undefined){let data3: any = data.pushKey;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(!pattern191.test(data3)){validateDeviceNotificationSettingsUpdateRequest.errors = [{instancePath:instancePath+"/pushKey",schemaPath:"#/properties/pushKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{1622}==$"}}];return false;}}else {validateDeviceNotificationSettingsUpdateRequest.errors = [{instancePath:instancePath+"/pushKey",schemaPath:"#/properties/pushKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.webPushKeys !== undefined){const _errs9: any = errors;if(!(validateWebPushKeys.call(this, data.webPushKeys, {instancePath:instancePath+"/webPushKeys",parentData:data,parentDataProperty:"webPushKeys",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWebPushKeys.errors : vErrors.concat(validateWebPushKeys.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}}else {validateDeviceNotificationSettingsUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceNotificationSettingsUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceNotificationSettingsUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
/** Checks that a value is a {@link DevicePushAddressUpdateRequest}. */
// prettier-ignore
export const validateDevicePushAddressUpdateRequest: CompiledSchemaCheck<DevicePushAddressUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DevicePushAddressUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDevicePushAddressUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.platform;if(typeof tag0 == "string"){if(tag0 === "apns"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.platform === undefined) && (missing0 = "platform")) || ((data.address === undefined) && (missing0 = "address"))){validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "platform") || (key0 === "address"))){validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.platform !== undefined){let data0: any = data.platform;const _errs5: any = errors;if(typeof data0 !== "string"){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}if("apns" !== data0){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/const",keyword:"const",params:{allowedValue: "apns"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.address !== undefined){let data1: any = data.address;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 2048){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/maxLength",keyword:"maxLength",params:{limit: 2048}}];return false;}else {if(func1(data1) < 1){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "webPush"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.platform === undefined) && (missing1 = "platform")) || ((data.address === undefined) && (missing1 = "address"))){validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!((key1 === "platform") || (key1 === "address"))){validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.platform !== undefined){let data2: any = data.platform;const _errs12: any = errors;if(typeof data2 !== "string"){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/1/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}if("webPush" !== data2){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/1/properties/platform/const",keyword:"const",params:{allowedValue: "webPush"}}];return false;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.address !== undefined){let data3: any = data.address;const _errs14: any = errors;if(errors === _errs14){if(errors === _errs14){if(typeof data3 === "string"){if(func1(data3) > 2048){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/1/properties/address/maxLength",keyword:"maxLength",params:{limit: 2048}}];return false;}else {if(!pattern33.test(data3)){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/1/properties/address/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data3))){validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/1/properties/address/format",keyword:"format",params:{format: "https-url"}}];return false;}}}}else {validateDevicePushAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/1/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}else {validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "platform", tagValue: tag0}}];return false;}}else {validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "platform", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateDevicePushAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDevicePushAddressUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDevicePushAddressUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
  Object.freeze({
    "device.subscribe": Object.freeze({
      method: "device.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateDeviceListSnapshot,
      emissionCheck: validateDeviceListEvent,
    }),
    "device.link.start": Object.freeze({
      method: "device.link.start",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateEmptyPayload,
      responseCheck: validateDeviceLinkStartResponse,
    }),
    "device.link.redeem": Object.freeze({
      method: "device.link.redeem",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceLinkRedeemRequest,
      responseCheck: validateDeviceLinkRedeemResponse,
    }),
    "device.link.confirm": Object.freeze({
      method: "device.link.confirm",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceLinkConfirmRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.link.cancel": Object.freeze({
      method: "device.link.cancel",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceLinkCancelRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.rename": Object.freeze({
      method: "device.rename",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceRenameRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.revoke": Object.freeze({
      method: "device.revoke",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceRevokeRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.forget": Object.freeze({
      method: "device.forget",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateDeviceForgetRequest,
      responseCheck: validateEmptyPayload,
    }),
    "device.statement.list": Object.freeze({
      method: "device.statement.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateDeviceStatementListRequest,
      responseCheck: validateDeviceStatementListResponse,
    }),
    "device.pushAddress.update": Object.freeze({
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
export const DEVICE_METHOD_DESCRIPTORS: DeviceMethodDescriptors = Object.freeze({
  "device.statement.apply": Object.freeze({
    method: "device.statement.apply",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDeviceStatementApplyRequest,
    responseCheck: validateEmptyPayload,
  }),
  "device.trusted.list": Object.freeze({
    method: "device.trusted.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDeviceTrustedListResponse,
  }),
  "device.notificationSettings.update": Object.freeze({
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
export const CONTROL_PLANE_METHOD_DESCRIPTORS: ControlPlaneMethodDescriptors = Object.freeze({
  "controlPlane.call": Object.freeze({
    method: "controlPlane.call",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateControlPlaneCallRequest,
    responseCheck: validateControlPlaneCallResponse,
  }),
});
