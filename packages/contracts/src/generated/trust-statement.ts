// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The account's trust, as every machine verifies it: the identity and channel keys, who signed, and the append-only chain of signed statements the control plane keeps and serves.
//
// Trust is the chain, not the control plane. Every machine checks each statement itself and trusts a key only when a path of statements reaches it from its own machine key, so every request that changes who is trusted carries a statement signed by one of the person's own keys rather than asking the control plane to decide.

import { type CompiledSchemaCheck, ucs2length } from "../schema-check.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import { type MachineId, validateMachineId } from "./machine/id.js";

/** The longest name a machine or a device carries: the one name every other device shows. */
export const MACHINE_OR_DEVICE_NAME_MAX_LEN = 256 as const;

/** The longest platform description, such as `iPhone`, `Chrome on Windows` or `macOS 15.6`. */
export const PLATFORM_DESCRIPTION_MAX_LEN = 128 as const;

/** `WebAuthn` caps a credential id at 1,023 bytes, which is 1,364 base64url characters. */
export const PASSKEY_ID_MAX_LEN = 1364 as const;

/** The longest device id any wire member carries. */
export const DEVICE_ID_MAX_LEN = 256 as const;

/**
 * The algorithms an identity key may use: a phone's Secure Enclave holds only P-256, and a
 * machine's service key is Ed25519, so every public key carries its tag.
 */
export const IDENTITY_KEY_ALGORITHMS = ["p256", "ed25519"] as const;

/**
 * The kinds of statement in the account's chain, each a fact named subject first and past
 * tense; the event that announces a statement carries its kind as its name.
 */
export const TRUST_STATEMENT_KINDS = [
  "device.linked",
  "device.renamed",
  "device.revoked",
  "account.passkey.added",
  "account.passkey.removed",
  "machine.added",
  "machine.renamed",
  "machine.removed",
] as const;

/**
 * The id of one of the person's devices: a phone or browser the control plane registers, or
 * a machine, whose own id is the device of every local connection to its service. Opaque to
 * every client; not blank, no NUL, and at most `DEVICE_ID_MAX_LEN` code points.
 */
export type DeviceId = string & { readonly __brand: "DeviceId" };
/**
 * The SHA-256 of a statement's canonical bytes (RFC 8785), as 64 lowercase hex characters.
 * The chain names each statement's predecessor by it, and a channel open exchanges the newest
 * one as the chain head.
 */
export type TrustStatementHash = string;
/**
 * One identity-key algorithm.
 */
export type IdentityKeyAlgorithm = "p256" | "ed25519";
/**
 * The public half of a machine's or a device's identity key, standard base64: an
 * Ed25519 key is 32 bytes, a P-256 key its 65-byte uncompressed point.
 */
export type IdentityPublicKey =
  | {
      algorithm: "p256";
      /**
       * The 65-byte uncompressed point.
       */
      publicKey: string;
    }
  | {
      algorithm: "ed25519";
      /**
       * The 32-byte key.
       */
      publicKey: string;
    };
/**
 * A machine's identity key: the service's Ed25519 key, which signs the machine's statements and
 * certifies its channel key.
 */
export type MachineIdentityKey = {
  algorithm: "ed25519";
  /**
   * The 32-byte key.
   */
  publicKey: string;
};
/**
 * The public half of the X25519 key a machine or device runs its encrypted channel with, 32
 * bytes in standard base64. The identity key certifies it in the statement that trusts that
 * identity, so the chain stays the one record of trust.
 */
export type ChannelPublicKey = {
  algorithm: "x25519";
  /**
   * The 32-byte key.
   */
  publicKey: string;
};
/**
 * A COSE algorithm a passkey signs with: EdDSA (-8), ES256 (-7) or RS256 (-257).
 */
export type CoseAlgorithm = -8 | -7 | -257;
/**
 * The key behind a statement or an entry: a device's, a machine's or a passkey's.
 */
export type TrustSigner =
  | {
      signer: "device";
      /**
       * The device.
       */
      deviceId: DeviceId;
    }
  | {
      signer: "machine";
      /**
       * The machine.
       */
      machineId: MachineId;
    }
  | {
      signer: "passkey";
      /**
       * The passkey's credential id.
       */
      passkeyId: string;
    };
/**
 * One signature over a statement's canonical bytes without its `signatures`. A device or machine
 * key signs directly; a passkey signs through a `WebAuthn` assertion, whose three parts arrive
 * base64url as the platform returns them.
 */
export type TrustStatementSignature =
  | {
      signer: "device";
      /**
       * The device.
       */
      deviceId: DeviceId;
      /**
       * The signature, standard base64.
       */
      signature: string;
    }
  | {
      signer: "machine";
      /**
       * The machine.
       */
      machineId: MachineId;
      /**
       * The signature, standard base64.
       */
      signature: string;
    }
  | {
      signer: "passkey";
      /**
       * The passkey's credential id.
       */
      passkeyId: string;
      /**
       * The assertion's authenticator data.
       */
      authenticatorData: string;
      /**
       * The assertion's client data.
       */
      clientDataJson: string;
      /**
       * The assertion's signature.
       */
      signature: string;
      /**
       * The nonce the assertion's challenge was made from with the statement's hash.
       */
      challengeNonce: string;
    };
/**
 * One statement kind.
 */
export type TrustStatementKind =
  | "device.linked"
  | "device.renamed"
  | "device.revoked"
  | "account.passkey.added"
  | "account.passkey.removed"
  | "machine.added"
  | "machine.renamed"
  | "machine.removed";
/**
 * One statement of the account's chain, told apart by its `kind`.
 */
export type TrustStatement =
  | {
      kind: "device.linked";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The device.
       */
      deviceId: DeviceId;
      /**
       * The device's identity key.
       */
      identityKey: IdentityPublicKey;
      /**
       * The device's channel key.
       */
      channelKey: ChannelPublicKey;
      /**
       * The device's one name.
       */
      name: string;
      /**
       * The device's platform.
       */
      platform: string;
    }
  | {
      kind: "device.renamed";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The device.
       */
      deviceId: DeviceId;
      /**
       * The device's new name.
       */
      name: string;
    }
  | {
      kind: "device.revoked";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The device.
       */
      deviceId: DeviceId;
    }
  | {
      kind: "account.passkey.added";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The passkey's credential id.
       */
      passkeyId: string;
      /**
       * The passkey's public key.
       */
      publicKey: PasskeyPublicKey;
      /**
       * The platform that holds the passkey.
       */
      platform: string;
    }
  | {
      kind: "account.passkey.removed";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The passkey's credential id.
       */
      passkeyId: string;
    }
  | {
      kind: "machine.added";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash | null;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The machine.
       */
      machineId: MachineId;
      /**
       * The machine's identity key.
       */
      identityKey: MachineIdentityKey;
      /**
       * The machine's channel key.
       */
      channelKey: ChannelPublicKey;
      /**
       * The machine's one name.
       */
      name: string;
    }
  | {
      kind: "machine.renamed";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The machine.
       */
      machineId: MachineId;
      /**
       * The machine's new name.
       */
      name: string;
    }
  | {
      kind: "machine.removed";
      /**
       * The hash of the statement before this one.
       */
      previousHash: TrustStatementHash;
      /**
       * When the statement was signed.
       */
      issuedAt: WireInstant;
      /**
       * The signatures over the statement's canonical bytes without this member.
       *
       * @minItems 1
       */
      signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
      /**
       * The machine.
       */
      machineId: MachineId;
    };

/**
 * A passkey's public key as its authenticator made it: the COSE key, base64url, and its
 * algorithm, which the machines' verifier reads.
 */
export interface PasskeyPublicKey {
  /**
   * The key's COSE algorithm.
   */
  coseAlgorithm: CoseAlgorithm;
  /**
   * The COSE key's bytes.
   */
  coseKey: string;
}
/**
 * A device joins: its identity key, its channel key, its name and its platform.
 */
export interface DeviceLinkedStatement {
  /**
   * The statement's kind.
   */
  kind: "device.linked";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The device.
   */
  deviceId: DeviceId;
  /**
   * The device's identity key.
   */
  identityKey: IdentityPublicKey;
  /**
   * The device's channel key.
   */
  channelKey: ChannelPublicKey;
  /**
   * The device's one name.
   */
  name: string;
  /**
   * The device's platform.
   */
  platform: string;
}
/**
 * A device's one name changes.
 */
export interface DeviceRenamedStatement {
  /**
   * The statement's kind.
   */
  kind: "device.renamed";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The device.
   */
  deviceId: DeviceId;
  /**
   * The device's new name.
   */
  name: string;
}
/**
 * A device's key ends here; what it signed before stands.
 */
export interface DeviceRevokedStatement {
  /**
   * The statement's kind.
   */
  kind: "device.revoked";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The device.
   */
  deviceId: DeviceId;
}
/**
 * A passkey joins, with the platform that holds it.
 */
export interface AccountPasskeyAddedStatement {
  /**
   * The statement's kind.
   */
  kind: "account.passkey.added";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The passkey's credential id.
   */
  passkeyId: string;
  /**
   * The passkey's public key.
   */
  publicKey: PasskeyPublicKey;
  /**
   * The platform that holds the passkey.
   */
  platform: string;
}
/**
 * A passkey's key ends here.
 */
export interface AccountPasskeyRemovedStatement {
  /**
   * The statement's kind.
   */
  kind: "account.passkey.removed";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The passkey's credential id.
   */
  passkeyId: string;
}
/**
 * A machine joins, or a removed machine comes back under its same id with a new key. The
 * person's first machine opens the chain with this statement, so here alone `previousHash`
 * is `null`; the key is still required.
 */
export interface MachineAddedStatement {
  /**
   * The statement's kind.
   */
  kind: "machine.added";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash | null;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The machine.
   */
  machineId: MachineId;
  /**
   * The machine's identity key.
   */
  identityKey: MachineIdentityKey;
  /**
   * The machine's channel key.
   */
  channelKey: ChannelPublicKey;
  /**
   * The machine's one name.
   */
  name: string;
}
/**
 * A machine's one name changes.
 */
export interface MachineRenamedStatement {
  /**
   * The statement's kind.
   */
  kind: "machine.renamed";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The machine.
   */
  machineId: MachineId;
  /**
   * The machine's new name.
   */
  name: string;
}
/**
 * A machine's key ends here; its store, sessions and id stay.
 */
export interface MachineRemovedStatement {
  /**
   * The statement's kind.
   */
  kind: "machine.removed";
  /**
   * The hash of the statement before this one.
   */
  previousHash: TrustStatementHash;
  /**
   * When the statement was signed.
   */
  issuedAt: WireInstant;
  /**
   * The signatures over the statement's canonical bytes without this member.
   *
   * @minItems 1
   */
  signatures: [TrustStatementSignature, ...TrustStatementSignature[]];
  /**
   * The machine.
   */
  machineId: MachineId;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link DeviceId}. */
// prettier-ignore
export const validateDeviceId: CompiledSchemaCheck<DeviceId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateDeviceId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern5.test(data)){validateDeviceId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateDeviceId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateDeviceId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern87 = new RegExp("^[0-9a-f]{64}$", "u");
/** Checks that a value is a {@link TrustStatementHash}. */
// prettier-ignore
export const validateTrustStatementHash: CompiledSchemaCheck<TrustStatementHash> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustStatementHash {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTrustStatementHash.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern87.test(data)){validateTrustStatementHash.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validateTrustStatementHash.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateTrustStatementHash.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTrustStatementHash.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern164 = new RegExp("^[A-Za-z0-9+/]{87}=$", "u");
// prettier-ignore
const pattern165 = new RegExp("^[A-Za-z0-9+/]{43}=$", "u");
/** Checks that a value is a {@link IdentityPublicKey}. */
// prettier-ignore
export const validateIdentityPublicKey: CompiledSchemaCheck<IdentityPublicKey> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is IdentityPublicKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateIdentityPublicKey.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.algorithm;if(typeof tag0 == "string"){if(tag0 === "p256"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.algorithm === undefined) && (missing0 = "algorithm")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))){validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "algorithm") || (key0 === "publicKey"))){validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.algorithm !== undefined){let data0: any = data.algorithm;const _errs5: any = errors;if(typeof data0 !== "string"){validateIdentityPublicKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("p256" !== data0){validateIdentityPublicKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "p256"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.publicKey !== undefined){let data1: any = data.publicKey;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern164.test(data1)){validateIdentityPublicKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{87}=$"}}];return false;}}else {validateIdentityPublicKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "ed25519"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.algorithm === undefined) && (missing1 = "algorithm")) || ((data.publicKey === undefined) && (missing1 = "publicKey"))){validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!((key1 === "algorithm") || (key1 === "publicKey"))){validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.algorithm !== undefined){let data2: any = data.algorithm;const _errs12: any = errors;if(typeof data2 !== "string"){validateIdentityPublicKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/1/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("ed25519" !== data2){validateIdentityPublicKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/1/properties/algorithm/const",keyword:"const",params:{allowedValue: "ed25519"}}];return false;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.publicKey !== undefined){let data3: any = data.publicKey;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(!pattern165.test(data3)){validateIdentityPublicKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/1/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validateIdentityPublicKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/1/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}else {validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag0}}];return false;}}else {validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateIdentityPublicKey.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateIdentityPublicKey.errors = vErrors;return errors === 0;};
// prettier-ignore
validateIdentityPublicKey.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link MachineIdentityKey}. */
// prettier-ignore
export const validateMachineIdentityKey: CompiledSchemaCheck<MachineIdentityKey> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineIdentityKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMachineIdentityKey.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.algorithm;if(typeof tag0 == "string"){if(tag0 === "ed25519"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.algorithm === undefined) && (missing0 = "algorithm")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))){validateMachineIdentityKey.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "algorithm") || (key0 === "publicKey"))){validateMachineIdentityKey.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.algorithm !== undefined){let data0: any = data.algorithm;const _errs5: any = errors;if(typeof data0 !== "string"){validateMachineIdentityKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("ed25519" !== data0){validateMachineIdentityKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "ed25519"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.publicKey !== undefined){let data1: any = data.publicKey;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern165.test(data1)){validateMachineIdentityKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validateMachineIdentityKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateMachineIdentityKey.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else {validateMachineIdentityKey.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag0}}];return false;}}else {validateMachineIdentityKey.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key1 in data){if(!props0 || !props0[key1]){validateMachineIdentityKey.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key1}}];return false;break;}}}}}else {validateMachineIdentityKey.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateMachineIdentityKey.errors = vErrors;return errors === 0;};
// prettier-ignore
validateMachineIdentityKey.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ChannelPublicKey}. */
// prettier-ignore
export const validateChannelPublicKey: CompiledSchemaCheck<ChannelPublicKey> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChannelPublicKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateChannelPublicKey.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.algorithm;if(typeof tag0 == "string"){if(tag0 === "x25519"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.algorithm === undefined) && (missing0 = "algorithm")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))){validateChannelPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "algorithm") || (key0 === "publicKey"))){validateChannelPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.algorithm !== undefined){let data0: any = data.algorithm;const _errs5: any = errors;if(typeof data0 !== "string"){validateChannelPublicKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("x25519" !== data0){validateChannelPublicKey.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "x25519"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.publicKey !== undefined){let data1: any = data.publicKey;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern165.test(data1)){validateChannelPublicKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validateChannelPublicKey.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateChannelPublicKey.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else {validateChannelPublicKey.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag0}}];return false;}}else {validateChannelPublicKey.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key1 in data){if(!props0 || !props0[key1]){validateChannelPublicKey.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key1}}];return false;break;}}}}}else {validateChannelPublicKey.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateChannelPublicKey.errors = vErrors;return errors === 0;};
// prettier-ignore
validateChannelPublicKey.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema332: any = {"description":"A COSE algorithm a passkey signs with: EdDSA (-8), ES256 (-7) or RS256 (-257).","type":"integer","enum":[-8,-7,-257]};
/** Checks that a value is a {@link CoseAlgorithm}. */
// prettier-ignore
export const validateCoseAlgorithm: CompiledSchemaCheck<CoseAlgorithm> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CoseAlgorithm {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCoseAlgorithm.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validateCoseAlgorithm.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(!(((data === -8) || (data === -7)) || (data === -257))){validateCoseAlgorithm.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema332.enum}}];return false;}validateCoseAlgorithm.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCoseAlgorithm.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern10 = new RegExp("^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$", "u");
/** Checks that a value is a {@link PasskeyPublicKey}. */
// prettier-ignore
export const validatePasskeyPublicKey: CompiledSchemaCheck<PasskeyPublicKey> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PasskeyPublicKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePasskeyPublicKey.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.coseAlgorithm === undefined) && (missing0 = "coseAlgorithm")) || ((data.coseKey === undefined) && (missing0 = "coseKey"))){validatePasskeyPublicKey.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "coseAlgorithm") || (key0 === "coseKey"))){validatePasskeyPublicKey.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.coseAlgorithm !== undefined){const _errs2: any = errors;if(!(validateCoseAlgorithm.call(this, data.coseAlgorithm, {instancePath:instancePath+"/coseAlgorithm",parentData:data,parentDataProperty:"coseAlgorithm",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCoseAlgorithm.errors : vErrors.concat(validateCoseAlgorithm.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.coseKey !== undefined){let data1: any = data.coseKey;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validatePasskeyPublicKey.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validatePasskeyPublicKey.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data1)){validatePasskeyPublicKey.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validatePasskeyPublicKey.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePasskeyPublicKey.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePasskeyPublicKey.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePasskeyPublicKey.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TrustSigner}. */
// prettier-ignore
export const validateTrustSigner: CompiledSchemaCheck<TrustSigner> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustSigner {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTrustSigner.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.signer;if(typeof tag0 == "string"){if(tag0 === "device"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.signer === undefined) && (missing0 = "signer")) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "signer") || (key0 === "deviceId"))){validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.signer !== undefined){let data0: any = data.signer;const _errs5: any = errors;if(typeof data0 !== "string"){validateTrustSigner.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("device" !== data0){validateTrustSigner.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/const",keyword:"const",params:{allowedValue: "device"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){const _errs7: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "machine"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.signer === undefined) && (missing1 = "signer")) || ((data.machineId === undefined) && (missing1 = "machineId"))){validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!((key1 === "signer") || (key1 === "machineId"))){validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.signer !== undefined){let data2: any = data.signer;const _errs11: any = errors;if(typeof data2 !== "string"){validateTrustSigner.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("machine" !== data2){validateTrustSigner.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/const",keyword:"const",params:{allowedValue: "machine"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.machineId !== undefined){const _errs13: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}}}}}else {validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "passkey"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.signer === undefined) && (missing2 = "signer")) || ((data.passkeyId === undefined) && (missing2 = "passkeyId"))){validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!((key2 === "signer") || (key2 === "passkeyId"))){validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.signer !== undefined){let data4: any = data.signer;const _errs17: any = errors;if(typeof data4 !== "string"){validateTrustSigner.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("passkey" !== data4){validateTrustSigner.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/const",keyword:"const",params:{allowedValue: "passkey"}}];return false;}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data.passkeyId !== undefined){let data5: any = data.passkeyId;const _errs19: any = errors;if(errors === _errs19){if(typeof data5 === "string"){if(func1(data5) > 1364){validateTrustSigner.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data5) < 1){validateTrustSigner.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data5)){validateTrustSigner.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustSigner.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}}}}}else {validateTrustSigner.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateTrustSigner.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "signer", tagValue: tag0}}];return false;}}else {validateTrustSigner.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "signer", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateTrustSigner.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateTrustSigner.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTrustSigner.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTrustSigner.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern157 = new RegExp("^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$", "u");
/** Checks that a value is a {@link TrustStatementSignature}. */
// prettier-ignore
export const validateTrustStatementSignature: CompiledSchemaCheck<TrustStatementSignature> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustStatementSignature {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTrustStatementSignature.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.signer;if(typeof tag0 == "string"){if(tag0 === "device"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.signer === undefined) && (missing0 = "signer")) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.signature === undefined) && (missing0 = "signature"))){validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "signer") || (key0 === "deviceId")) || (key0 === "signature"))){validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.signer !== undefined){let data0: any = data.signer;const _errs5: any = errors;if(typeof data0 !== "string"){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("device" !== data0){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/const",keyword:"const",params:{allowedValue: "device"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){const _errs7: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.signature !== undefined){let data2: any = data.signature;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 4096){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern157.test(data2)){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$"}}];return false;}}}}else {validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}}else {validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "machine"){const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.signer === undefined) && (missing1 = "signer")) || ((data.machineId === undefined) && (missing1 = "machineId"))) || ((data.signature === undefined) && (missing1 = "signature"))){validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs12: any = errors;for(const key1 in data){if(!(((key1 === "signer") || (key1 === "machineId")) || (key1 === "signature"))){validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs12 === errors){if(data.signer !== undefined){let data3: any = data.signer;const _errs13: any = errors;if(typeof data3 !== "string"){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("machine" !== data3){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/const",keyword:"const",params:{allowedValue: "machine"}}];return false;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.machineId !== undefined){const _errs15: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.signature !== undefined){let data5: any = data.signature;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) > 4096){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern157.test(data5)){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$"}}];return false;}}}}else {validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}}}}}}else {validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs10 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "passkey"){const _errs18: any = errors;if(errors === _errs18){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((data.signer === undefined) && (missing2 = "signer")) || ((data.passkeyId === undefined) && (missing2 = "passkeyId"))) || ((data.authenticatorData === undefined) && (missing2 = "authenticatorData"))) || ((data.clientDataJson === undefined) && (missing2 = "clientDataJson"))) || ((data.signature === undefined) && (missing2 = "signature"))) || ((data.challengeNonce === undefined) && (missing2 = "challengeNonce"))){validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs20: any = errors;for(const key2 in data){if(!((((((key2 === "signer") || (key2 === "passkeyId")) || (key2 === "authenticatorData")) || (key2 === "clientDataJson")) || (key2 === "signature")) || (key2 === "challengeNonce"))){validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs20 === errors){if(data.signer !== undefined){let data6: any = data.signer;const _errs21: any = errors;if(typeof data6 !== "string"){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("passkey" !== data6){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/const",keyword:"const",params:{allowedValue: "passkey"}}];return false;}var valid6: any = _errs21 === errors;}else {var valid6: any = true;}if(valid6){if(data.passkeyId !== undefined){let data7: any = data.passkeyId;const _errs23: any = errors;if(errors === _errs23){if(typeof data7 === "string"){if(func1(data7) > 1364){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data7) < 1){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data7)){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustStatementSignature.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs23 === errors;}else {var valid6: any = true;}if(valid6){if(data.authenticatorData !== undefined){let data8: any = data.authenticatorData;const _errs25: any = errors;if(errors === _errs25){if(typeof data8 === "string"){if(func1(data8) > 4096){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data8) < 1){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data8)){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustStatementSignature.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs25 === errors;}else {var valid6: any = true;}if(valid6){if(data.clientDataJson !== undefined){let data9: any = data.clientDataJson;const _errs27: any = errors;if(errors === _errs27){if(typeof data9 === "string"){if(func1(data9) > 4096){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data9)){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustStatementSignature.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}if(valid6){if(data.signature !== undefined){let data10: any = data.signature;const _errs29: any = errors;if(errors === _errs29){if(typeof data10 === "string"){if(func1(data10) > 4096){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data10) < 1){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data10)){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustStatementSignature.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs29 === errors;}else {var valid6: any = true;}if(valid6){if(data.challengeNonce !== undefined){let data11: any = data.challengeNonce;const _errs31: any = errors;if(errors === _errs31){if(typeof data11 === "string"){if(func1(data11) > 43){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data11) < 43){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern10.test(data11)){validateTrustStatementSignature.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustStatementSignature.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs31 === errors;}else {var valid6: any = true;}}}}}}}}}else {validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs18 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "signer", tagValue: tag0}}];return false;}}else {validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "signer", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateTrustStatementSignature.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTrustStatementSignature.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTrustStatementSignature.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema329: any = {"description":"One statement kind.","type":"string","enum":["device.linked","device.renamed","device.revoked","account.passkey.added","account.passkey.removed","machine.added","machine.renamed","machine.removed"]};
/** Checks that a value is a {@link TrustStatementKind}. */
// prettier-ignore
export const validateTrustStatementKind: CompiledSchemaCheck<TrustStatementKind> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustStatementKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTrustStatementKind.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateTrustStatementKind.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((((data === "device.linked") || (data === "device.renamed")) || (data === "device.revoked")) || (data === "account.passkey.added")) || (data === "account.passkey.removed")) || (data === "machine.added")) || (data === "machine.renamed")) || (data === "machine.removed"))){validateTrustStatementKind.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema329.enum}}];return false;}validateTrustStatementKind.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTrustStatementKind.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema317: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The statement's kind.","type":"string","enum":["device.linked"]},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."},"identityKey":{"$ref":"#/$defs/IdentityPublicKey","description":"The device's identity key."},"channelKey":{"$ref":"#/$defs/ChannelPublicKey","description":"The device's channel key."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The device's one name."},"platform":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The device's platform."}},"required":["kind","previousHash","issuedAt","signatures","deviceId","identityKey","channelKey","name","platform"],"description":"A device joins: its identity key, its channel key, its name and its platform."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link DeviceLinkedStatement}. */
// prettier-ignore
export const validateDeviceLinkedStatement: CompiledSchemaCheck<DeviceLinkedStatement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceLinkedStatement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceLinkedStatement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.previousHash === undefined) && (missing0 = "previousHash"))) || ((data.issuedAt === undefined) && (missing0 = "issuedAt"))) || ((data.signatures === undefined) && (missing0 = "signatures"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.identityKey === undefined) && (missing0 = "identityKey"))) || ((data.channelKey === undefined) && (missing0 = "channelKey"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.platform === undefined) && (missing0 = "platform"))){validateDeviceLinkedStatement.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema317.properties, key0))){validateDeviceLinkedStatement.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;if(typeof data0 !== "string"){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "device.linked")){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema317.properties.kind.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.previousHash !== undefined){const _errs4: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.issuedAt !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.signatures !== undefined){let data3: any = data.signatures;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){if(data3.length < 1){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validateTrustStatementSignature.call(this, data3[i0], {instancePath:instancePath+"/signatures/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}}else {validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs9: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.identityKey !== undefined){const _errs10: any = errors;if(!(validateIdentityPublicKey.call(this, data.identityKey, {instancePath:instancePath+"/identityKey",parentData:data,parentDataProperty:"identityKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateIdentityPublicKey.errors : vErrors.concat(validateIdentityPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.channelKey !== undefined){const _errs11: any = errors;if(!(validateChannelPublicKey.call(this, data.channelKey, {instancePath:instancePath+"/channelKey",parentData:data,parentDataProperty:"channelKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChannelPublicKey.errors : vErrors.concat(validateChannelPublicKey.errors);errors = vErrors.length;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data8: any = data.name;const _errs12: any = errors;if(errors === _errs12){if(typeof data8 === "string"){if(func1(data8) > 256){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data8) < 1){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data8)){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.platform !== undefined){let data9: any = data.platform;const _errs14: any = errors;if(errors === _errs14){if(typeof data9 === "string"){if(func1(data9) > 128){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data9) < 1){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data9)){validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceLinkedStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validateDeviceLinkedStatement.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceLinkedStatement.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceLinkedStatement.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema342: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The statement's kind.","type":"string","enum":["device.renamed"]},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The device's new name."}},"required":["kind","previousHash","issuedAt","signatures","deviceId","name"],"description":"A device's one name changes."};
/** Checks that a value is a {@link DeviceRenamedStatement}. */
// prettier-ignore
export const validateDeviceRenamedStatement: CompiledSchemaCheck<DeviceRenamedStatement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceRenamedStatement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceRenamedStatement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.kind === undefined) && (missing0 = "kind")) || ((data.previousHash === undefined) && (missing0 = "previousHash"))) || ((data.issuedAt === undefined) && (missing0 = "issuedAt"))) || ((data.signatures === undefined) && (missing0 = "signatures"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.name === undefined) && (missing0 = "name"))){validateDeviceRenamedStatement.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "kind") || (key0 === "previousHash")) || (key0 === "issuedAt")) || (key0 === "signatures")) || (key0 === "deviceId")) || (key0 === "name"))){validateDeviceRenamedStatement.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;if(typeof data0 !== "string"){validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "device.renamed")){validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema342.properties.kind.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.previousHash !== undefined){const _errs4: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.issuedAt !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.signatures !== undefined){let data3: any = data.signatures;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){if(data3.length < 1){validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validateTrustStatementSignature.call(this, data3[i0], {instancePath:instancePath+"/signatures/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}}else {validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs9: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data6: any = data.name;const _errs10: any = errors;if(errors === _errs10){if(typeof data6 === "string"){if(func1(data6) > 256){validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data6)){validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDeviceRenamedStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateDeviceRenamedStatement.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceRenamedStatement.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceRenamedStatement.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema344: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The statement's kind.","type":"string","enum":["device.revoked"]},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."}},"required":["kind","previousHash","issuedAt","signatures","deviceId"],"description":"A device's key ends here; what it signed before stands."};
/** Checks that a value is a {@link DeviceRevokedStatement}. */
// prettier-ignore
export const validateDeviceRevokedStatement: CompiledSchemaCheck<DeviceRevokedStatement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceRevokedStatement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDeviceRevokedStatement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.previousHash === undefined) && (missing0 = "previousHash"))) || ((data.issuedAt === undefined) && (missing0 = "issuedAt"))) || ((data.signatures === undefined) && (missing0 = "signatures"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validateDeviceRevokedStatement.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "kind") || (key0 === "previousHash")) || (key0 === "issuedAt")) || (key0 === "signatures")) || (key0 === "deviceId"))){validateDeviceRevokedStatement.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;if(typeof data0 !== "string"){validateDeviceRevokedStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "device.revoked")){validateDeviceRevokedStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema344.properties.kind.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.previousHash !== undefined){const _errs4: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.issuedAt !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.signatures !== undefined){let data3: any = data.signatures;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){if(data3.length < 1){validateDeviceRevokedStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validateTrustStatementSignature.call(this, data3[i0], {instancePath:instancePath+"/signatures/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}}else {validateDeviceRevokedStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs9: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}}else {validateDeviceRevokedStatement.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDeviceRevokedStatement.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDeviceRevokedStatement.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema330: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"device.linked"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."},"identityKey":{"$ref":"#/$defs/IdentityPublicKey","description":"The device's identity key."},"channelKey":{"$ref":"#/$defs/ChannelPublicKey","description":"The device's channel key."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The device's one name."},"platform":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The device's platform."}},"required":["kind","previousHash","issuedAt","signatures","deviceId","identityKey","channelKey","name","platform"],"description":"A device joins: its identity key, its channel key, its name and its platform."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"device.renamed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The device's new name."}},"required":["kind","previousHash","issuedAt","signatures","deviceId","name"],"description":"A device's one name changes."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"device.revoked"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."}},"required":["kind","previousHash","issuedAt","signatures","deviceId"],"description":"A device's key ends here; what it signed before stands."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"account.passkey.added"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"passkeyId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The passkey's credential id."},"publicKey":{"$ref":"#/$defs/PasskeyPublicKey","description":"The passkey's public key."},"platform":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The platform that holds the passkey."}},"required":["kind","previousHash","issuedAt","signatures","passkeyId","publicKey","platform"],"description":"A passkey joins, with the platform that holds it."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"account.passkey.removed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"passkeyId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The passkey's credential id."}},"required":["kind","previousHash","issuedAt","signatures","passkeyId"],"description":"A passkey's key ends here."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"machine.added"},"previousHash":{"anyOf":[{"$ref":"#/$defs/TrustStatementHash"},{"type":"null"}],"description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"The machine."},"identityKey":{"$ref":"#/$defs/MachineIdentityKey","description":"The machine's identity key."},"channelKey":{"$ref":"#/$defs/ChannelPublicKey","description":"The machine's channel key."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The machine's one name."}},"required":["kind","previousHash","issuedAt","signatures","machineId","identityKey","channelKey","name"],"description":"A machine joins, or a removed machine comes back under its same id with a new key. The\nperson's first machine opens the chain with this statement, so here alone `previousHash`\nis `null`; the key is still required."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"machine.renamed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"The machine."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The machine's new name."}},"required":["kind","previousHash","issuedAt","signatures","machineId","name"],"description":"A machine's one name changes."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"machine.removed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"The machine."}},"required":["kind","previousHash","issuedAt","signatures","machineId"],"description":"A machine's key ends here; its store, sessions and id stay."}],"description":"One statement of the account's chain, told apart by its `kind`.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
/** Checks that a value is a {@link TrustStatement}. */
// prettier-ignore
export const validateTrustStatement: CompiledSchemaCheck<TrustStatement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustStatement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTrustStatement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "device.linked"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.previousHash === undefined) && (missing0 = "previousHash"))) || ((data.issuedAt === undefined) && (missing0 = "issuedAt"))) || ((data.signatures === undefined) && (missing0 = "signatures"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.identityKey === undefined) && (missing0 = "identityKey"))) || ((data.channelKey === undefined) && (missing0 = "channelKey"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.platform === undefined) && (missing0 = "platform"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema330.oneOf[0].properties, key0))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("device.linked" !== data0){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "device.linked"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.previousHash !== undefined){const _errs7: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.issuedAt !== undefined){const _errs8: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.signatures !== undefined){let data3: any = data.signatures;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data3)){if(data3.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/0/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid3: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validateTrustStatementSignature.call(this, data3[i0], {instancePath:instancePath+"/signatures/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid3: any = _errs11 === errors;if(!valid3){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/0/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){const _errs12: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.identityKey !== undefined){const _errs13: any = errors;if(!(validateIdentityPublicKey.call(this, data.identityKey, {instancePath:instancePath+"/identityKey",parentData:data,parentDataProperty:"identityKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateIdentityPublicKey.errors : vErrors.concat(validateIdentityPublicKey.errors);errors = vErrors.length;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.channelKey !== undefined){const _errs14: any = errors;if(!(validateChannelPublicKey.call(this, data.channelKey, {instancePath:instancePath+"/channelKey",parentData:data,parentDataProperty:"channelKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChannelPublicKey.errors : vErrors.concat(validateChannelPublicKey.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data8: any = data.name;const _errs15: any = errors;if(errors === _errs15){if(typeof data8 === "string"){if(func1(data8) > 256){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data8) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data8)){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.platform !== undefined){let data9: any = data.platform;const _errs17: any = errors;if(errors === _errs17){if(typeof data9 === "string"){if(func1(data9) > 128){validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data9) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data9)){validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}}}}}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "device.renamed"){const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((data.kind === undefined) && (missing1 = "kind")) || ((data.previousHash === undefined) && (missing1 = "previousHash"))) || ((data.issuedAt === undefined) && (missing1 = "issuedAt"))) || ((data.signatures === undefined) && (missing1 = "signatures"))) || ((data.deviceId === undefined) && (missing1 = "deviceId"))) || ((data.name === undefined) && (missing1 = "name"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs21: any = errors;for(const key1 in data){if(!((((((key1 === "kind") || (key1 === "previousHash")) || (key1 === "issuedAt")) || (key1 === "signatures")) || (key1 === "deviceId")) || (key1 === "name"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs21 === errors){if(data.kind !== undefined){let data10: any = data.kind;const _errs22: any = errors;if(typeof data10 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("device.renamed" !== data10){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "device.renamed"}}];return false;}var valid5: any = _errs22 === errors;}else {var valid5: any = true;}if(valid5){if(data.previousHash !== undefined){const _errs24: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid5: any = _errs24 === errors;}else {var valid5: any = true;}if(valid5){if(data.issuedAt !== undefined){const _errs25: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid5: any = _errs25 === errors;}else {var valid5: any = true;}if(valid5){if(data.signatures !== undefined){let data13: any = data.signatures;const _errs26: any = errors;if(errors === _errs26){if(Array.isArray(data13)){if(data13.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/1/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid6: any = true;const len1: any = data13.length;for(let i1=0; i1<len1; i1++){const _errs28: any = errors;if(!(validateTrustStatementSignature.call(this, data13[i1], {instancePath:instancePath+"/signatures/" + i1,parentData:data13,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid6: any = _errs28 === errors;if(!valid6){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/1/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data.deviceId !== undefined){const _errs29: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid5: any = _errs29 === errors;}else {var valid5: any = true;}if(valid5){if(data.name !== undefined){let data16: any = data.name;const _errs30: any = errors;if(errors === _errs30){if(typeof data16 === "string"){if(func1(data16) > 256){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data16) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data16)){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs30 === errors;}else {var valid5: any = true;}}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs19 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else if(tag0 === "device.revoked"){const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((((data.kind === undefined) && (missing2 = "kind")) || ((data.previousHash === undefined) && (missing2 = "previousHash"))) || ((data.issuedAt === undefined) && (missing2 = "issuedAt"))) || ((data.signatures === undefined) && (missing2 = "signatures"))) || ((data.deviceId === undefined) && (missing2 = "deviceId"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs34: any = errors;for(const key2 in data){if(!(((((key2 === "kind") || (key2 === "previousHash")) || (key2 === "issuedAt")) || (key2 === "signatures")) || (key2 === "deviceId"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs34 === errors){if(data.kind !== undefined){let data17: any = data.kind;const _errs35: any = errors;if(typeof data17 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("device.revoked" !== data17){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "device.revoked"}}];return false;}var valid8: any = _errs35 === errors;}else {var valid8: any = true;}if(valid8){if(data.previousHash !== undefined){const _errs37: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid8: any = _errs37 === errors;}else {var valid8: any = true;}if(valid8){if(data.issuedAt !== undefined){const _errs38: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid8: any = _errs38 === errors;}else {var valid8: any = true;}if(valid8){if(data.signatures !== undefined){let data20: any = data.signatures;const _errs39: any = errors;if(errors === _errs39){if(Array.isArray(data20)){if(data20.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/2/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid9: any = true;const len2: any = data20.length;for(let i2=0; i2<len2; i2++){const _errs41: any = errors;if(!(validateTrustStatementSignature.call(this, data20[i2], {instancePath:instancePath+"/signatures/" + i2,parentData:data20,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid9: any = _errs41 === errors;if(!valid9){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/2/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid8: any = _errs39 === errors;}else {var valid8: any = true;}if(valid8){if(data.deviceId !== undefined){const _errs42: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid8: any = _errs42 === errors;}else {var valid8: any = true;}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs32 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else if(tag0 === "account.passkey.added"){const _errs43: any = errors;if(errors === _errs43){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((((((data.kind === undefined) && (missing3 = "kind")) || ((data.previousHash === undefined) && (missing3 = "previousHash"))) || ((data.issuedAt === undefined) && (missing3 = "issuedAt"))) || ((data.signatures === undefined) && (missing3 = "signatures"))) || ((data.passkeyId === undefined) && (missing3 = "passkeyId"))) || ((data.publicKey === undefined) && (missing3 = "publicKey"))) || ((data.platform === undefined) && (missing3 = "platform"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs45: any = errors;for(const key3 in data){if(!(((((((key3 === "kind") || (key3 === "previousHash")) || (key3 === "issuedAt")) || (key3 === "signatures")) || (key3 === "passkeyId")) || (key3 === "publicKey")) || (key3 === "platform"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs45 === errors){if(data.kind !== undefined){let data23: any = data.kind;const _errs46: any = errors;if(typeof data23 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("account.passkey.added" !== data23){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "account.passkey.added"}}];return false;}var valid11: any = _errs46 === errors;}else {var valid11: any = true;}if(valid11){if(data.previousHash !== undefined){const _errs48: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid11: any = _errs48 === errors;}else {var valid11: any = true;}if(valid11){if(data.issuedAt !== undefined){const _errs49: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid11: any = _errs49 === errors;}else {var valid11: any = true;}if(valid11){if(data.signatures !== undefined){let data26: any = data.signatures;const _errs50: any = errors;if(errors === _errs50){if(Array.isArray(data26)){if(data26.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/3/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid12: any = true;const len3: any = data26.length;for(let i3=0; i3<len3; i3++){const _errs52: any = errors;if(!(validateTrustStatementSignature.call(this, data26[i3], {instancePath:instancePath+"/signatures/" + i3,parentData:data26,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid12: any = _errs52 === errors;if(!valid12){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/3/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid11: any = _errs50 === errors;}else {var valid11: any = true;}if(valid11){if(data.passkeyId !== undefined){let data28: any = data.passkeyId;const _errs53: any = errors;if(errors === _errs53){if(typeof data28 === "string"){if(func1(data28) > 1364){validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data28) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data28)){validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs53 === errors;}else {var valid11: any = true;}if(valid11){if(data.publicKey !== undefined){const _errs55: any = errors;if(!(validatePasskeyPublicKey.call(this, data.publicKey, {instancePath:instancePath+"/publicKey",parentData:data,parentDataProperty:"publicKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePasskeyPublicKey.errors : vErrors.concat(validatePasskeyPublicKey.errors);errors = vErrors.length;}var valid11: any = _errs55 === errors;}else {var valid11: any = true;}if(valid11){if(data.platform !== undefined){let data30: any = data.platform;const _errs56: any = errors;if(errors === _errs56){if(typeof data30 === "string"){if(func1(data30) > 128){validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data30) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data30)){validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs56 === errors;}else {var valid11: any = true;}}}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs43 === errors;if(props0 !== true){props0 = true;}valid0 = valid10;}else if(tag0 === "account.passkey.removed"){const _errs58: any = errors;if(errors === _errs58){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((((data.kind === undefined) && (missing4 = "kind")) || ((data.previousHash === undefined) && (missing4 = "previousHash"))) || ((data.issuedAt === undefined) && (missing4 = "issuedAt"))) || ((data.signatures === undefined) && (missing4 = "signatures"))) || ((data.passkeyId === undefined) && (missing4 = "passkeyId"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs60: any = errors;for(const key4 in data){if(!(((((key4 === "kind") || (key4 === "previousHash")) || (key4 === "issuedAt")) || (key4 === "signatures")) || (key4 === "passkeyId"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs60 === errors){if(data.kind !== undefined){let data31: any = data.kind;const _errs61: any = errors;if(typeof data31 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("account.passkey.removed" !== data31){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "account.passkey.removed"}}];return false;}var valid14: any = _errs61 === errors;}else {var valid14: any = true;}if(valid14){if(data.previousHash !== undefined){const _errs63: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid14: any = _errs63 === errors;}else {var valid14: any = true;}if(valid14){if(data.issuedAt !== undefined){const _errs64: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid14: any = _errs64 === errors;}else {var valid14: any = true;}if(valid14){if(data.signatures !== undefined){let data34: any = data.signatures;const _errs65: any = errors;if(errors === _errs65){if(Array.isArray(data34)){if(data34.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/4/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid15: any = true;const len4: any = data34.length;for(let i4=0; i4<len4; i4++){const _errs67: any = errors;if(!(validateTrustStatementSignature.call(this, data34[i4], {instancePath:instancePath+"/signatures/" + i4,parentData:data34,parentDataProperty:i4,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid15: any = _errs67 === errors;if(!valid15){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/4/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid14: any = _errs65 === errors;}else {var valid14: any = true;}if(valid14){if(data.passkeyId !== undefined){let data36: any = data.passkeyId;const _errs68: any = errors;if(errors === _errs68){if(typeof data36 === "string"){if(func1(data36) > 1364){validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data36) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data36)){validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs68 === errors;}else {var valid14: any = true;}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs58 === errors;if(props0 !== true){props0 = true;}valid0 = valid13;}else if(tag0 === "machine.added"){const _errs70: any = errors;if(errors === _errs70){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((((((data.kind === undefined) && (missing5 = "kind")) || ((data.previousHash === undefined) && (missing5 = "previousHash"))) || ((data.issuedAt === undefined) && (missing5 = "issuedAt"))) || ((data.signatures === undefined) && (missing5 = "signatures"))) || ((data.machineId === undefined) && (missing5 = "machineId"))) || ((data.identityKey === undefined) && (missing5 = "identityKey"))) || ((data.channelKey === undefined) && (missing5 = "channelKey"))) || ((data.name === undefined) && (missing5 = "name"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs72: any = errors;for(const key5 in data){if(!((((((((key5 === "kind") || (key5 === "previousHash")) || (key5 === "issuedAt")) || (key5 === "signatures")) || (key5 === "machineId")) || (key5 === "identityKey")) || (key5 === "channelKey")) || (key5 === "name"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs72 === errors){if(data.kind !== undefined){let data37: any = data.kind;const _errs73: any = errors;if(typeof data37 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("machine.added" !== data37){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "machine.added"}}];return false;}var valid17: any = _errs73 === errors;}else {var valid17: any = true;}if(valid17){if(data.previousHash !== undefined){let data38: any = data.previousHash;const _errs75: any = errors;const _errs76: any = errors;let valid18: any = false;const _errs77: any = errors;if(!(validateTrustStatementHash.call(this, data38, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var _valid0: any = _errs77 === errors;valid18 = valid18 || _valid0;const _errs78: any = errors;if(data38 !== null){const err0: any = {instancePath:instancePath+"/previousHash",schemaPath:"#/oneOf/5/properties/previousHash/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs78 === errors;valid18 = valid18 || _valid0;if(!valid18){const err1: any = {instancePath:instancePath+"/previousHash",schemaPath:"#/oneOf/5/properties/previousHash/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateTrustStatement.errors = vErrors;return false;}else {errors = _errs76;if(vErrors !== null){if(_errs76){vErrors.length = _errs76;}else {vErrors = null;}}}var valid17: any = _errs75 === errors;}else {var valid17: any = true;}if(valid17){if(data.issuedAt !== undefined){const _errs80: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid17: any = _errs80 === errors;}else {var valid17: any = true;}if(valid17){if(data.signatures !== undefined){let data40: any = data.signatures;const _errs81: any = errors;if(errors === _errs81){if(Array.isArray(data40)){if(data40.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/5/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid19: any = true;const len5: any = data40.length;for(let i5=0; i5<len5; i5++){const _errs83: any = errors;if(!(validateTrustStatementSignature.call(this, data40[i5], {instancePath:instancePath+"/signatures/" + i5,parentData:data40,parentDataProperty:i5,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid19: any = _errs83 === errors;if(!valid19){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/5/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid17: any = _errs81 === errors;}else {var valid17: any = true;}if(valid17){if(data.machineId !== undefined){const _errs84: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid17: any = _errs84 === errors;}else {var valid17: any = true;}if(valid17){if(data.identityKey !== undefined){const _errs85: any = errors;if(!(validateMachineIdentityKey.call(this, data.identityKey, {instancePath:instancePath+"/identityKey",parentData:data,parentDataProperty:"identityKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineIdentityKey.errors : vErrors.concat(validateMachineIdentityKey.errors);errors = vErrors.length;}var valid17: any = _errs85 === errors;}else {var valid17: any = true;}if(valid17){if(data.channelKey !== undefined){const _errs86: any = errors;if(!(validateChannelPublicKey.call(this, data.channelKey, {instancePath:instancePath+"/channelKey",parentData:data,parentDataProperty:"channelKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChannelPublicKey.errors : vErrors.concat(validateChannelPublicKey.errors);errors = vErrors.length;}var valid17: any = _errs86 === errors;}else {var valid17: any = true;}if(valid17){if(data.name !== undefined){let data45: any = data.name;const _errs87: any = errors;if(errors === _errs87){if(typeof data45 === "string"){if(func1(data45) > 256){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data45) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data45)){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs87 === errors;}else {var valid17: any = true;}}}}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid16: any = _errs70 === errors;if(props0 !== true){props0 = true;}valid0 = valid16;}else if(tag0 === "machine.renamed"){const _errs89: any = errors;if(errors === _errs89){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((((((data.kind === undefined) && (missing6 = "kind")) || ((data.previousHash === undefined) && (missing6 = "previousHash"))) || ((data.issuedAt === undefined) && (missing6 = "issuedAt"))) || ((data.signatures === undefined) && (missing6 = "signatures"))) || ((data.machineId === undefined) && (missing6 = "machineId"))) || ((data.name === undefined) && (missing6 = "name"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs91: any = errors;for(const key6 in data){if(!((((((key6 === "kind") || (key6 === "previousHash")) || (key6 === "issuedAt")) || (key6 === "signatures")) || (key6 === "machineId")) || (key6 === "name"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs91 === errors){if(data.kind !== undefined){let data46: any = data.kind;const _errs92: any = errors;if(typeof data46 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("machine.renamed" !== data46){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "machine.renamed"}}];return false;}var valid21: any = _errs92 === errors;}else {var valid21: any = true;}if(valid21){if(data.previousHash !== undefined){const _errs94: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid21: any = _errs94 === errors;}else {var valid21: any = true;}if(valid21){if(data.issuedAt !== undefined){const _errs95: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid21: any = _errs95 === errors;}else {var valid21: any = true;}if(valid21){if(data.signatures !== undefined){let data49: any = data.signatures;const _errs96: any = errors;if(errors === _errs96){if(Array.isArray(data49)){if(data49.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/6/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid22: any = true;const len6: any = data49.length;for(let i6=0; i6<len6; i6++){const _errs98: any = errors;if(!(validateTrustStatementSignature.call(this, data49[i6], {instancePath:instancePath+"/signatures/" + i6,parentData:data49,parentDataProperty:i6,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid22: any = _errs98 === errors;if(!valid22){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/6/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid21: any = _errs96 === errors;}else {var valid21: any = true;}if(valid21){if(data.machineId !== undefined){const _errs99: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid21: any = _errs99 === errors;}else {var valid21: any = true;}if(valid21){if(data.name !== undefined){let data52: any = data.name;const _errs100: any = errors;if(errors === _errs100){if(typeof data52 === "string"){if(func1(data52) > 256){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data52) < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data52)){validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs100 === errors;}else {var valid21: any = true;}}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}var valid20: any = _errs89 === errors;if(props0 !== true){props0 = true;}valid0 = valid20;}else if(tag0 === "machine.removed"){const _errs102: any = errors;if(errors === _errs102){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if((((((data.kind === undefined) && (missing7 = "kind")) || ((data.previousHash === undefined) && (missing7 = "previousHash"))) || ((data.issuedAt === undefined) && (missing7 = "issuedAt"))) || ((data.signatures === undefined) && (missing7 = "signatures"))) || ((data.machineId === undefined) && (missing7 = "machineId"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {const _errs104: any = errors;for(const key7 in data){if(!(((((key7 === "kind") || (key7 === "previousHash")) || (key7 === "issuedAt")) || (key7 === "signatures")) || (key7 === "machineId"))){validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}}];return false;break;}}if(_errs104 === errors){if(data.kind !== undefined){let data53: any = data.kind;const _errs105: any = errors;if(typeof data53 !== "string"){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("machine.removed" !== data53){validateTrustStatement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/const",keyword:"const",params:{allowedValue: "machine.removed"}}];return false;}var valid24: any = _errs105 === errors;}else {var valid24: any = true;}if(valid24){if(data.previousHash !== undefined){const _errs107: any = errors;if(!(validateTrustStatementHash.call(this, data.previousHash, {instancePath:instancePath+"/previousHash",parentData:data,parentDataProperty:"previousHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementHash.errors : vErrors.concat(validateTrustStatementHash.errors);errors = vErrors.length;}var valid24: any = _errs107 === errors;}else {var valid24: any = true;}if(valid24){if(data.issuedAt !== undefined){const _errs108: any = errors;if(!(validateWireInstant.call(this, data.issuedAt, {instancePath:instancePath+"/issuedAt",parentData:data,parentDataProperty:"issuedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid24: any = _errs108 === errors;}else {var valid24: any = true;}if(valid24){if(data.signatures !== undefined){let data56: any = data.signatures;const _errs109: any = errors;if(errors === _errs109){if(Array.isArray(data56)){if(data56.length < 1){validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/7/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid25: any = true;const len7: any = data56.length;for(let i7=0; i7<len7; i7++){const _errs111: any = errors;if(!(validateTrustStatementSignature.call(this, data56[i7], {instancePath:instancePath+"/signatures/" + i7,parentData:data56,parentDataProperty:i7,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTrustStatementSignature.errors : vErrors.concat(validateTrustStatementSignature.errors);errors = vErrors.length;}var valid25: any = _errs111 === errors;if(!valid25){break;}}}}else {validateTrustStatement.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/7/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid24: any = _errs109 === errors;}else {var valid24: any = true;}if(valid24){if(data.machineId !== undefined){const _errs112: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid24: any = _errs112 === errors;}else {var valid24: any = true;}}}}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"}}];return false;}}var valid23: any = _errs102 === errors;if(props0 !== true){props0 = true;}valid0 = valid23;}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key8 in data){if(!props0 || !props0[key8]){validateTrustStatement.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key8}}];return false;break;}}}}}else {validateTrustStatement.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTrustStatement.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTrustStatement.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
