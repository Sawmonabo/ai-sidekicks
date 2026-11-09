/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The account's trust, as every machine verifies it: the identity and channel keys, who signed, and the append-only chain of signed statements the control plane keeps and serves.
//
// Trust is the chain, not the control plane. Every machine checks each statement itself and trusts a key only when a path of statements reaches it from its own machine key, so every request that changes who is trusted carries a statement signed by one of the person's own keys rather than asking the control plane to decide.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import type { MachineId } from "./machine/id.js";

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
const pattern445 = new RegExp("^[A-Za-z0-9+/]{43}=$", "u");
// prettier-ignore
function validate2218(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChannelPublicKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2218.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2218.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.algorithm;if(typeof tag0 == "string"){if(tag0 === "x25519"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.algorithm === undefined) && (missing0 = "algorithm")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))){validate2218.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "algorithm") || (key1 === "publicKey"))){validate2218.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.algorithm !== undefined){let data0: any = data.algorithm;const _errs6: any = errors;if(typeof data0 !== "string"){validate2218.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("x25519" !== data0){validate2218.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "x25519"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.publicKey !== undefined){let data1: any = data.publicKey;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern445.test(data1)){validate2218.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validate2218.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate2218.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2218.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag0}}];return false;}}else {validate2218.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag0}}];return false;}}}else {validate2218.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2218.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2218.errors = null as any[] | null;
// prettier-ignore
validate2218.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate2219(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2219.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate2219.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data)){validate2219.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2219.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2219.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2219.errors = null as any[] | null;
// prettier-ignore
validate2219.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema835: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The statement's kind.","type":"string","enum":["device.renamed"]},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The device's new name."}},"required":["kind","previousHash","issuedAt","signatures","deviceId","name"],"description":"A device's one name changes."};
// prettier-ignore
const pattern220 = new RegExp("^[0-9a-f]{64}$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
const pattern436 = new RegExp("^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$", "u");
// prettier-ignore
const pattern14 = new RegExp("^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$", "u");
// prettier-ignore
function validate403(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate403.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate403.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.signer;if(typeof tag0 == "string"){if(tag0 === "device"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.signer === undefined) && (missing0 = "signer")) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.signature === undefined) && (missing0 = "signature"))){validate403.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((key1 === "signer") || (key1 === "deviceId")) || (key1 === "signature"))){validate403.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.signer !== undefined){let data0: any = data.signer;const _errs6: any = errors;if(typeof data0 !== "string"){validate403.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("device" !== data0){validate403.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/const",keyword:"const",params:{allowedValue: "device"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){let data1: any = data.deviceId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(func1(data1) > 256){validate403.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data1)){validate403.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate403.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.signature !== undefined){let data2: any = data.signature;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(func1(data2) > 4096){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern436.test(data2)){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$"}}];return false;}}}}else {validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}else {validate403.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "machine"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.signer === undefined) && (missing1 = "signer")) || ((data.machineId === undefined) && (missing1 = "machineId"))) || ((data.signature === undefined) && (missing1 = "signature"))){validate403.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(((key2 === "signer") || (key2 === "machineId")) || (key2 === "signature"))){validate403.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.signer !== undefined){let data3: any = data.signer;const _errs17: any = errors;if(typeof data3 !== "string"){validate403.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("machine" !== data3){validate403.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/const",keyword:"const",params:{allowedValue: "machine"}}];return false;}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.machineId !== undefined){let data4: any = data.machineId;const _errs19: any = errors;const _errs20: any = errors;if(errors === _errs20){if(typeof data4 === "string"){if(func1(data4) > 256){validate403.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate403.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate403.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.signature !== undefined){let data5: any = data.signature;const _errs23: any = errors;if(errors === _errs23){if(typeof data5 === "string"){if(func1(data5) > 4096){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern436.test(data5)){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$"}}];return false;}}}}else {validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs23 === errors;}else {var valid5: any = true;}}}}}}else {validate403.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "passkey"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((data.signer === undefined) && (missing2 = "signer")) || ((data.passkeyId === undefined) && (missing2 = "passkeyId"))) || ((data.authenticatorData === undefined) && (missing2 = "authenticatorData"))) || ((data.clientDataJson === undefined) && (missing2 = "clientDataJson"))) || ((data.signature === undefined) && (missing2 = "signature"))) || ((data.challengeNonce === undefined) && (missing2 = "challengeNonce"))){validate403.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs27: any = errors;for(const key3 in data){if(!((((((key3 === "signer") || (key3 === "passkeyId")) || (key3 === "authenticatorData")) || (key3 === "clientDataJson")) || (key3 === "signature")) || (key3 === "challengeNonce"))){validate403.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs27 === errors){if(data.signer !== undefined){let data6: any = data.signer;const _errs28: any = errors;if(typeof data6 !== "string"){validate403.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("passkey" !== data6){validate403.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/const",keyword:"const",params:{allowedValue: "passkey"}}];return false;}var valid8: any = _errs28 === errors;}else {var valid8: any = true;}if(valid8){if(data.passkeyId !== undefined){let data7: any = data.passkeyId;const _errs30: any = errors;if(errors === _errs30){if(typeof data7 === "string"){if(func1(data7) > 1364){validate403.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data7) < 1){validate403.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data7)){validate403.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate403.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}if(valid8){if(data.authenticatorData !== undefined){let data8: any = data.authenticatorData;const _errs32: any = errors;if(errors === _errs32){if(typeof data8 === "string"){if(func1(data8) > 4096){validate403.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data8) < 1){validate403.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data8)){validate403.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate403.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs32 === errors;}else {var valid8: any = true;}if(valid8){if(data.clientDataJson !== undefined){let data9: any = data.clientDataJson;const _errs34: any = errors;if(errors === _errs34){if(typeof data9 === "string"){if(func1(data9) > 4096){validate403.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validate403.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data9)){validate403.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate403.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs34 === errors;}else {var valid8: any = true;}if(valid8){if(data.signature !== undefined){let data10: any = data.signature;const _errs36: any = errors;if(errors === _errs36){if(typeof data10 === "string"){if(func1(data10) > 4096){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data10) < 1){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data10)){validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate403.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs36 === errors;}else {var valid8: any = true;}if(valid8){if(data.challengeNonce !== undefined){let data11: any = data.challengeNonce;const _errs38: any = errors;if(errors === _errs38){if(typeof data11 === "string"){if(func1(data11) > 43){validate403.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data11) < 43){validate403.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern14.test(data11)){validate403.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate403.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs38 === errors;}else {var valid8: any = true;}}}}}}}}}else {validate403.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate403.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "signer", tagValue: tag0}}];return false;}}else {validate403.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "signer", tagValue: tag0}}];return false;}}}else {validate403.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate403.errors = vErrors;return errors === 0;}
// prettier-ignore
validate403.errors = null as any[] | null;
// prettier-ignore
validate403.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2220(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeviceRenamedStatement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2220.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.kind === undefined) && (missing0 = "kind")) || ((data.previousHash === undefined) && (missing0 = "previousHash"))) || ((data.issuedAt === undefined) && (missing0 = "issuedAt"))) || ((data.signatures === undefined) && (missing0 = "signatures"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.name === undefined) && (missing0 = "name"))){validate2220.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "kind") || (key0 === "previousHash")) || (key0 === "issuedAt")) || (key0 === "signatures")) || (key0 === "deviceId")) || (key0 === "name"))){validate2220.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;if(typeof data0 !== "string"){validate2220.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "device.renamed")){validate2220.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema835.properties.kind.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.previousHash !== undefined){let data1: any = data.previousHash;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern220.test(data1)){validate2220.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2220.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.issuedAt !== undefined){let data2: any = data.issuedAt;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(!pattern5.test(data2)){validate2220.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2220.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.signatures !== undefined){let data3: any = data.signatures;const _errs10: any = errors;if(errors === _errs10){if(Array.isArray(data3)){if(data3.length < 1){validate2220.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid3: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs12: any = errors;if(!(validate403.call(this, data3[i0], {instancePath:instancePath+"/signatures/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid3: any = _errs12 === errors;if(!valid3){break;}}}}else {validate2220.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){let data5: any = data.deviceId;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) > 256){validate2220.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data5)){validate2220.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2220.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data6: any = data.name;const _errs17: any = errors;if(errors === _errs17){if(typeof data6 === "string"){if(func1(data6) > 256){validate2220.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validate2220.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data6)){validate2220.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2220.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate2220.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2220.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2220.errors = null as any[] | null;
// prettier-ignore
validate2220.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern444 = new RegExp("^[A-Za-z0-9+/]{87}=$", "u");
// prettier-ignore
function validate2222(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is IdentityPublicKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2222.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2222.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.algorithm;if(typeof tag0 == "string"){if(tag0 === "p256"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.algorithm === undefined) && (missing0 = "algorithm")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))){validate2222.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "algorithm") || (key1 === "publicKey"))){validate2222.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.algorithm !== undefined){let data0: any = data.algorithm;const _errs6: any = errors;if(typeof data0 !== "string"){validate2222.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("p256" !== data0){validate2222.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "p256"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.publicKey !== undefined){let data1: any = data.publicKey;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern444.test(data1)){validate2222.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{87}=$"}}];return false;}}else {validate2222.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate2222.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "ed25519"){const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.algorithm === undefined) && (missing1 = "algorithm")) || ((data.publicKey === undefined) && (missing1 = "publicKey"))){validate2222.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs12: any = errors;for(const key2 in data){if(!((key2 === "algorithm") || (key2 === "publicKey"))){validate2222.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs12 === errors){if(data.algorithm !== undefined){let data2: any = data.algorithm;const _errs13: any = errors;if(typeof data2 !== "string"){validate2222.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/1/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("ed25519" !== data2){validate2222.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/1/properties/algorithm/const",keyword:"const",params:{allowedValue: "ed25519"}}];return false;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.publicKey !== undefined){let data3: any = data.publicKey;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(!pattern445.test(data3)){validate2222.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/1/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validate2222.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/1/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}}}}}else {validate2222.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2222.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag0}}];return false;}}else {validate2222.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag0}}];return false;}}}else {validate2222.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2222.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2222.errors = null as any[] | null;
// prettier-ignore
validate2222.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2223(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineIdentityKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2223.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2223.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.algorithm;if(typeof tag0 == "string"){if(tag0 === "ed25519"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.algorithm === undefined) && (missing0 = "algorithm")) || ((data.publicKey === undefined) && (missing0 = "publicKey"))){validate2223.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "algorithm") || (key1 === "publicKey"))){validate2223.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.algorithm !== undefined){let data0: any = data.algorithm;const _errs6: any = errors;if(typeof data0 !== "string"){validate2223.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("ed25519" !== data0){validate2223.errors = [{instancePath:instancePath+"/algorithm",schemaPath:"#/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "ed25519"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.publicKey !== undefined){let data1: any = data.publicKey;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern445.test(data1)){validate2223.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validate2223.errors = [{instancePath:instancePath+"/publicKey",schemaPath:"#/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate2223.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2223.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag0}}];return false;}}else {validate2223.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag0}}];return false;}}}else {validate2223.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2223.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2223.errors = null as any[] | null;
// prettier-ignore
validate2223.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema801: any = {"description":"A COSE algorithm a passkey signs with: EdDSA (-8), ES256 (-7) or RS256 (-257).","type":"integer","enum":[-8,-7,-257]};
// prettier-ignore
function validate2224(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PasskeyPublicKey {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2224.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.coseAlgorithm === undefined) && (missing0 = "coseAlgorithm")) || ((data.coseKey === undefined) && (missing0 = "coseKey"))){validate2224.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "coseAlgorithm") || (key0 === "coseKey"))){validate2224.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.coseAlgorithm !== undefined){let data0: any = data.coseAlgorithm;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate2224.errors = [{instancePath:instancePath+"/coseAlgorithm",schemaPath:"#/$defs/CoseAlgorithm/type",keyword:"type",params:{type: "integer"}}];return false;}if(!(((data0 === -8) || (data0 === -7)) || (data0 === -257))){validate2224.errors = [{instancePath:instancePath+"/coseAlgorithm",schemaPath:"#/$defs/CoseAlgorithm/enum",keyword:"enum",params:{allowedValues: schema801.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.coseKey !== undefined){let data1: any = data.coseKey;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) > 4096){validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data1)){validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2224.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2224.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2224.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2224.errors = null as any[] | null;
// prettier-ignore
validate2224.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema786: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"device.linked"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."},"identityKey":{"$ref":"#/$defs/IdentityPublicKey","description":"The device's identity key."},"channelKey":{"$ref":"#/$defs/ChannelPublicKey","description":"The device's channel key."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The device's one name."},"platform":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The device's platform."}},"required":["kind","previousHash","issuedAt","signatures","deviceId","identityKey","channelKey","name","platform"],"description":"A device joins: its identity key, its channel key, its name and its platform."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"device.renamed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The device's new name."}},"required":["kind","previousHash","issuedAt","signatures","deviceId","name"],"description":"A device's one name changes."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"device.revoked"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"deviceId":{"$ref":"#/$defs/DeviceId","description":"The device."}},"required":["kind","previousHash","issuedAt","signatures","deviceId"],"description":"A device's key ends here; what it signed before stands."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"account.passkey.added"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"passkeyId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The passkey's credential id."},"publicKey":{"$ref":"#/$defs/PasskeyPublicKey","description":"The passkey's public key."},"platform":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The platform that holds the passkey."}},"required":["kind","previousHash","issuedAt","signatures","passkeyId","publicKey","platform"],"description":"A passkey joins, with the platform that holds it."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"account.passkey.removed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"passkeyId":{"type":"string","minLength":1,"maxLength":1364,"pattern":"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$","description":"The passkey's credential id."}},"required":["kind","previousHash","issuedAt","signatures","passkeyId"],"description":"A passkey's key ends here."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"machine.added"},"previousHash":{"anyOf":[{"$ref":"#/$defs/TrustStatementHash"},{"type":"null"}],"description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"The machine."},"identityKey":{"$ref":"#/$defs/MachineIdentityKey","description":"The machine's identity key."},"channelKey":{"$ref":"#/$defs/ChannelPublicKey","description":"The machine's channel key."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The machine's one name."}},"required":["kind","previousHash","issuedAt","signatures","machineId","identityKey","channelKey","name"],"description":"A machine joins, or a removed machine comes back under its same id with a new key. The\nperson's first machine opens the chain with this statement, so here alone `previousHash`\nis `null`; the key is still required."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"machine.renamed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"The machine."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The machine's new name."}},"required":["kind","previousHash","issuedAt","signatures","machineId","name"],"description":"A machine's one name changes."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"machine.removed"},"previousHash":{"$ref":"#/$defs/TrustStatementHash","description":"The hash of the statement before this one."},"issuedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the statement was signed."},"signatures":{"type":"array","items":{"$ref":"#/$defs/TrustStatementSignature"},"minItems":1,"description":"The signatures over the statement's canonical bytes without this member."},"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"The machine."}},"required":["kind","previousHash","issuedAt","signatures","machineId"],"description":"A machine's key ends here; its store, sessions and id stay."}],"description":"One statement of the account's chain, told apart by its `kind`.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate418(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate418.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.coseAlgorithm === undefined) && (missing0 = "coseAlgorithm")) || ((data.coseKey === undefined) && (missing0 = "coseKey"))){validate418.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "coseAlgorithm") || (key0 === "coseKey"))){validate418.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.coseAlgorithm !== undefined){let data0: any = data.coseAlgorithm;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate418.errors = [{instancePath:instancePath+"/coseAlgorithm",schemaPath:"#/$defs/CoseAlgorithm/type",keyword:"type",params:{type: "integer"}}];return false;}if(!(((data0 === -8) || (data0 === -7)) || (data0 === -257))){validate418.errors = [{instancePath:instancePath+"/coseAlgorithm",schemaPath:"#/$defs/CoseAlgorithm/enum",keyword:"enum",params:{allowedValues: schema801.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.coseKey !== undefined){let data1: any = data.coseKey;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) > 4096){validate418.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate418.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data1)){validate418.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate418.errors = [{instancePath:instancePath+"/coseKey",schemaPath:"#/properties/coseKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate418.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate418.errors = vErrors;return errors === 0;}
// prettier-ignore
validate418.errors = null as any[] | null;
// prettier-ignore
validate418.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2225(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustStatement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2225.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2225.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "device.linked"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.previousHash === undefined) && (missing0 = "previousHash"))) || ((data.issuedAt === undefined) && (missing0 = "issuedAt"))) || ((data.signatures === undefined) && (missing0 = "signatures"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.identityKey === undefined) && (missing0 = "identityKey"))) || ((data.channelKey === undefined) && (missing0 = "channelKey"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.platform === undefined) && (missing0 = "platform"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(func2.call(schema786.oneOf[0].properties, key1))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("device.linked" !== data0){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "device.linked"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.previousHash !== undefined){let data1: any = data.previousHash;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern220.test(data1)){validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.issuedAt !== undefined){let data2: any = data.issuedAt;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(!pattern5.test(data2)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.signatures !== undefined){let data3: any = data.signatures;const _errs14: any = errors;if(errors === _errs14){if(Array.isArray(data3)){if(data3.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/0/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid5: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs16: any = errors;if(!(validate403.call(this, data3[i0], {instancePath:instancePath+"/signatures/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid5: any = _errs16 === errors;if(!valid5){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/0/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){let data5: any = data.deviceId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) > 256){validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data5)){validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.identityKey !== undefined){let data6: any = data.identityKey;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){const _errs25: any = errors;for(const key2 in data6){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}if(_errs25 === errors){const tag1: any = data6.algorithm;if(typeof tag1 == "string"){if(tag1 === "p256"){const _errs26: any = errors;if(errors === _errs26){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){let missing1: any;if(((data6.algorithm === undefined) && (missing1 = "algorithm")) || ((data6.publicKey === undefined) && (missing1 = "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs28: any = errors;for(const key3 in data6){if(!((key3 === "algorithm") || (key3 === "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs28 === errors){if(data6.algorithm !== undefined){let data7: any = data6.algorithm;const _errs29: any = errors;if(typeof data7 !== "string"){validate2225.errors = [{instancePath:instancePath+"/identityKey/algorithm",schemaPath:"#/$defs/IdentityPublicKey/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("p256" !== data7){validate2225.errors = [{instancePath:instancePath+"/identityKey/algorithm",schemaPath:"#/$defs/IdentityPublicKey/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "p256"}}];return false;}var valid10: any = _errs29 === errors;}else {var valid10: any = true;}if(valid10){if(data6.publicKey !== undefined){let data8: any = data6.publicKey;const _errs31: any = errors;if(errors === _errs31){if(typeof data8 === "string"){if(!pattern444.test(data8)){validate2225.errors = [{instancePath:instancePath+"/identityKey/publicKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{87}=$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey/publicKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs31 === errors;}else {var valid10: any = true;}}}}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag1 === "ed25519"){const _errs33: any = errors;if(errors === _errs33){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){let missing2: any;if(((data6.algorithm === undefined) && (missing2 = "algorithm")) || ((data6.publicKey === undefined) && (missing2 = "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs35: any = errors;for(const key4 in data6){if(!((key4 === "algorithm") || (key4 === "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs35 === errors){if(data6.algorithm !== undefined){let data9: any = data6.algorithm;const _errs36: any = errors;if(typeof data9 !== "string"){validate2225.errors = [{instancePath:instancePath+"/identityKey/algorithm",schemaPath:"#/$defs/IdentityPublicKey/oneOf/1/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("ed25519" !== data9){validate2225.errors = [{instancePath:instancePath+"/identityKey/algorithm",schemaPath:"#/$defs/IdentityPublicKey/oneOf/1/properties/algorithm/const",keyword:"const",params:{allowedValue: "ed25519"}}];return false;}var valid12: any = _errs36 === errors;}else {var valid12: any = true;}if(valid12){if(data6.publicKey !== undefined){let data10: any = data6.publicKey;const _errs38: any = errors;if(errors === _errs38){if(typeof data10 === "string"){if(!pattern445.test(data10)){validate2225.errors = [{instancePath:instancePath+"/identityKey/publicKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/1/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey/publicKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/1/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs38 === errors;}else {var valid12: any = true;}}}}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag1}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag1}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/IdentityPublicKey/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs21 === errors;}else {var valid2: any = true;}if(valid2){if(data.channelKey !== undefined){let data11: any = data.channelKey;const _errs40: any = errors;const _errs41: any = errors;if(errors === _errs41){if(data11 && typeof data11 == "object" && !Array.isArray(data11)){const _errs44: any = errors;for(const key5 in data11){validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}if(_errs44 === errors){const tag2: any = data11.algorithm;if(typeof tag2 == "string"){if(tag2 === "x25519"){const _errs45: any = errors;if(errors === _errs45){if(data11 && typeof data11 == "object" && !Array.isArray(data11)){let missing3: any;if(((data11.algorithm === undefined) && (missing3 = "algorithm")) || ((data11.publicKey === undefined) && (missing3 = "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs47: any = errors;for(const key6 in data11){if(!((key6 === "algorithm") || (key6 === "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs47 === errors){if(data11.algorithm !== undefined){let data12: any = data11.algorithm;const _errs48: any = errors;if(typeof data12 !== "string"){validate2225.errors = [{instancePath:instancePath+"/channelKey/algorithm",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("x25519" !== data12){validate2225.errors = [{instancePath:instancePath+"/channelKey/algorithm",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "x25519"}}];return false;}var valid16: any = _errs48 === errors;}else {var valid16: any = true;}if(valid16){if(data11.publicKey !== undefined){let data13: any = data11.publicKey;const _errs50: any = errors;if(errors === _errs50){if(typeof data13 === "string"){if(!pattern445.test(data13)){validate2225.errors = [{instancePath:instancePath+"/channelKey/publicKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey/publicKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs50 === errors;}else {var valid16: any = true;}}}}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag2}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag2}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs40 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data14: any = data.name;const _errs52: any = errors;if(errors === _errs52){if(typeof data14 === "string"){if(func1(data14) > 256){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data14) < 1){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data14)){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs52 === errors;}else {var valid2: any = true;}if(valid2){if(data.platform !== undefined){let data15: any = data.platform;const _errs54: any = errors;if(errors === _errs54){if(typeof data15 === "string"){if(func1(data15) > 128){validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data15) < 1){validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data15)){validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/0/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs54 === errors;}else {var valid2: any = true;}}}}}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "device.renamed"){const _errs56: any = errors;if(errors === _errs56){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((((data.kind === undefined) && (missing4 = "kind")) || ((data.previousHash === undefined) && (missing4 = "previousHash"))) || ((data.issuedAt === undefined) && (missing4 = "issuedAt"))) || ((data.signatures === undefined) && (missing4 = "signatures"))) || ((data.deviceId === undefined) && (missing4 = "deviceId"))) || ((data.name === undefined) && (missing4 = "name"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs58: any = errors;for(const key7 in data){if(!((((((key7 === "kind") || (key7 === "previousHash")) || (key7 === "issuedAt")) || (key7 === "signatures")) || (key7 === "deviceId")) || (key7 === "name"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}}];return false;break;}}if(_errs58 === errors){if(data.kind !== undefined){let data16: any = data.kind;const _errs59: any = errors;if(typeof data16 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("device.renamed" !== data16){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "device.renamed"}}];return false;}var valid18: any = _errs59 === errors;}else {var valid18: any = true;}if(valid18){if(data.previousHash !== undefined){let data17: any = data.previousHash;const _errs61: any = errors;const _errs62: any = errors;if(errors === _errs62){if(typeof data17 === "string"){if(!pattern220.test(data17)){validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs61 === errors;}else {var valid18: any = true;}if(valid18){if(data.issuedAt !== undefined){let data18: any = data.issuedAt;const _errs64: any = errors;const _errs65: any = errors;if(errors === _errs65){if(typeof data18 === "string"){if(!pattern5.test(data18)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs64 === errors;}else {var valid18: any = true;}if(valid18){if(data.signatures !== undefined){let data19: any = data.signatures;const _errs67: any = errors;if(errors === _errs67){if(Array.isArray(data19)){if(data19.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/1/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid21: any = true;const len1: any = data19.length;for(let i1=0; i1<len1; i1++){const _errs69: any = errors;if(!(validate403.call(this, data19[i1], {instancePath:instancePath+"/signatures/" + i1,parentData:data19,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid21: any = _errs69 === errors;if(!valid21){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/1/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid18: any = _errs67 === errors;}else {var valid18: any = true;}if(valid18){if(data.deviceId !== undefined){let data21: any = data.deviceId;const _errs70: any = errors;const _errs71: any = errors;if(errors === _errs71){if(typeof data21 === "string"){if(func1(data21) > 256){validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data21)){validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs70 === errors;}else {var valid18: any = true;}if(valid18){if(data.name !== undefined){let data22: any = data.name;const _errs74: any = errors;if(errors === _errs74){if(typeof data22 === "string"){if(func1(data22) > 256){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data22) < 1){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data22)){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs74 === errors;}else {var valid18: any = true;}}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "device.revoked"){const _errs76: any = errors;if(errors === _errs76){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((((((data.kind === undefined) && (missing5 = "kind")) || ((data.previousHash === undefined) && (missing5 = "previousHash"))) || ((data.issuedAt === undefined) && (missing5 = "issuedAt"))) || ((data.signatures === undefined) && (missing5 = "signatures"))) || ((data.deviceId === undefined) && (missing5 = "deviceId"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs78: any = errors;for(const key8 in data){if(!(((((key8 === "kind") || (key8 === "previousHash")) || (key8 === "issuedAt")) || (key8 === "signatures")) || (key8 === "deviceId"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key8}}];return false;break;}}if(_errs78 === errors){if(data.kind !== undefined){let data23: any = data.kind;const _errs79: any = errors;if(typeof data23 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("device.revoked" !== data23){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "device.revoked"}}];return false;}var valid24: any = _errs79 === errors;}else {var valid24: any = true;}if(valid24){if(data.previousHash !== undefined){let data24: any = data.previousHash;const _errs81: any = errors;const _errs82: any = errors;if(errors === _errs82){if(typeof data24 === "string"){if(!pattern220.test(data24)){validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs81 === errors;}else {var valid24: any = true;}if(valid24){if(data.issuedAt !== undefined){let data25: any = data.issuedAt;const _errs84: any = errors;const _errs85: any = errors;if(errors === _errs85){if(typeof data25 === "string"){if(!pattern5.test(data25)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs84 === errors;}else {var valid24: any = true;}if(valid24){if(data.signatures !== undefined){let data26: any = data.signatures;const _errs87: any = errors;if(errors === _errs87){if(Array.isArray(data26)){if(data26.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/2/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid27: any = true;const len2: any = data26.length;for(let i2=0; i2<len2; i2++){const _errs89: any = errors;if(!(validate403.call(this, data26[i2], {instancePath:instancePath+"/signatures/" + i2,parentData:data26,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid27: any = _errs89 === errors;if(!valid27){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/2/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid24: any = _errs87 === errors;}else {var valid24: any = true;}if(valid24){if(data.deviceId !== undefined){let data28: any = data.deviceId;const _errs90: any = errors;const _errs91: any = errors;if(errors === _errs91){if(typeof data28 === "string"){if(func1(data28) > 256){validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data28)){validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid24: any = _errs90 === errors;}else {var valid24: any = true;}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "account.passkey.added"){const _errs94: any = errors;if(errors === _errs94){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((((((((data.kind === undefined) && (missing6 = "kind")) || ((data.previousHash === undefined) && (missing6 = "previousHash"))) || ((data.issuedAt === undefined) && (missing6 = "issuedAt"))) || ((data.signatures === undefined) && (missing6 = "signatures"))) || ((data.passkeyId === undefined) && (missing6 = "passkeyId"))) || ((data.publicKey === undefined) && (missing6 = "publicKey"))) || ((data.platform === undefined) && (missing6 = "platform"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs96: any = errors;for(const key9 in data){if(!(((((((key9 === "kind") || (key9 === "previousHash")) || (key9 === "issuedAt")) || (key9 === "signatures")) || (key9 === "passkeyId")) || (key9 === "publicKey")) || (key9 === "platform"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9}}];return false;break;}}if(_errs96 === errors){if(data.kind !== undefined){let data29: any = data.kind;const _errs97: any = errors;if(typeof data29 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("account.passkey.added" !== data29){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "account.passkey.added"}}];return false;}var valid30: any = _errs97 === errors;}else {var valid30: any = true;}if(valid30){if(data.previousHash !== undefined){let data30: any = data.previousHash;const _errs99: any = errors;const _errs100: any = errors;if(errors === _errs100){if(typeof data30 === "string"){if(!pattern220.test(data30)){validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid30: any = _errs99 === errors;}else {var valid30: any = true;}if(valid30){if(data.issuedAt !== undefined){let data31: any = data.issuedAt;const _errs102: any = errors;const _errs103: any = errors;if(errors === _errs103){if(typeof data31 === "string"){if(!pattern5.test(data31)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid30: any = _errs102 === errors;}else {var valid30: any = true;}if(valid30){if(data.signatures !== undefined){let data32: any = data.signatures;const _errs105: any = errors;if(errors === _errs105){if(Array.isArray(data32)){if(data32.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/3/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid33: any = true;const len3: any = data32.length;for(let i3=0; i3<len3; i3++){const _errs107: any = errors;if(!(validate403.call(this, data32[i3], {instancePath:instancePath+"/signatures/" + i3,parentData:data32,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid33: any = _errs107 === errors;if(!valid33){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/3/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid30: any = _errs105 === errors;}else {var valid30: any = true;}if(valid30){if(data.passkeyId !== undefined){let data34: any = data.passkeyId;const _errs108: any = errors;if(errors === _errs108){if(typeof data34 === "string"){if(func1(data34) > 1364){validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data34) < 1){validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data34)){validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/3/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid30: any = _errs108 === errors;}else {var valid30: any = true;}if(valid30){if(data.publicKey !== undefined){const _errs110: any = errors;if(!(validate418.call(this, data.publicKey, {instancePath:instancePath+"/publicKey",parentData:data,parentDataProperty:"publicKey",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate418.errors : vErrors.concat(validate418.errors);errors = vErrors.length;}var valid30: any = _errs110 === errors;}else {var valid30: any = true;}if(valid30){if(data.platform !== undefined){let data36: any = data.platform;const _errs111: any = errors;if(errors === _errs111){if(typeof data36 === "string"){if(func1(data36) > 128){validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data36) < 1){validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data36)){validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/platform",schemaPath:"#/oneOf/3/properties/platform/type",keyword:"type",params:{type: "string"}}];return false;}}var valid30: any = _errs111 === errors;}else {var valid30: any = true;}}}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "account.passkey.removed"){const _errs113: any = errors;if(errors === _errs113){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if((((((data.kind === undefined) && (missing7 = "kind")) || ((data.previousHash === undefined) && (missing7 = "previousHash"))) || ((data.issuedAt === undefined) && (missing7 = "issuedAt"))) || ((data.signatures === undefined) && (missing7 = "signatures"))) || ((data.passkeyId === undefined) && (missing7 = "passkeyId"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {const _errs115: any = errors;for(const key10 in data){if(!(((((key10 === "kind") || (key10 === "previousHash")) || (key10 === "issuedAt")) || (key10 === "signatures")) || (key10 === "passkeyId"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key10}}];return false;break;}}if(_errs115 === errors){if(data.kind !== undefined){let data37: any = data.kind;const _errs116: any = errors;if(typeof data37 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("account.passkey.removed" !== data37){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "account.passkey.removed"}}];return false;}var valid35: any = _errs116 === errors;}else {var valid35: any = true;}if(valid35){if(data.previousHash !== undefined){let data38: any = data.previousHash;const _errs118: any = errors;const _errs119: any = errors;if(errors === _errs119){if(typeof data38 === "string"){if(!pattern220.test(data38)){validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid35: any = _errs118 === errors;}else {var valid35: any = true;}if(valid35){if(data.issuedAt !== undefined){let data39: any = data.issuedAt;const _errs121: any = errors;const _errs122: any = errors;if(errors === _errs122){if(typeof data39 === "string"){if(!pattern5.test(data39)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid35: any = _errs121 === errors;}else {var valid35: any = true;}if(valid35){if(data.signatures !== undefined){let data40: any = data.signatures;const _errs124: any = errors;if(errors === _errs124){if(Array.isArray(data40)){if(data40.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/4/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid38: any = true;const len4: any = data40.length;for(let i4=0; i4<len4; i4++){const _errs126: any = errors;if(!(validate403.call(this, data40[i4], {instancePath:instancePath+"/signatures/" + i4,parentData:data40,parentDataProperty:i4,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid38: any = _errs126 === errors;if(!valid38){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/4/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid35: any = _errs124 === errors;}else {var valid35: any = true;}if(valid35){if(data.passkeyId !== undefined){let data42: any = data.passkeyId;const _errs127: any = errors;if(errors === _errs127){if(typeof data42 === "string"){if(func1(data42) > 1364){validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data42) < 1){validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data42)){validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/4/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid35: any = _errs127 === errors;}else {var valid35: any = true;}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "machine.added"){const _errs129: any = errors;if(errors === _errs129){if(data && typeof data == "object" && !Array.isArray(data)){let missing8: any;if(((((((((data.kind === undefined) && (missing8 = "kind")) || ((data.previousHash === undefined) && (missing8 = "previousHash"))) || ((data.issuedAt === undefined) && (missing8 = "issuedAt"))) || ((data.signatures === undefined) && (missing8 = "signatures"))) || ((data.machineId === undefined) && (missing8 = "machineId"))) || ((data.identityKey === undefined) && (missing8 = "identityKey"))) || ((data.channelKey === undefined) && (missing8 = "channelKey"))) || ((data.name === undefined) && (missing8 = "name"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing8}}];return false;}else {const _errs131: any = errors;for(const key11 in data){if(!((((((((key11 === "kind") || (key11 === "previousHash")) || (key11 === "issuedAt")) || (key11 === "signatures")) || (key11 === "machineId")) || (key11 === "identityKey")) || (key11 === "channelKey")) || (key11 === "name"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key11}}];return false;break;}}if(_errs131 === errors){if(data.kind !== undefined){let data43: any = data.kind;const _errs132: any = errors;if(typeof data43 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("machine.added" !== data43){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "machine.added"}}];return false;}var valid40: any = _errs132 === errors;}else {var valid40: any = true;}if(valid40){if(data.previousHash !== undefined){let data44: any = data.previousHash;const _errs134: any = errors;const _errs135: any = errors;let valid41: any = false;const _errs136: any = errors;const _errs137: any = errors;if(errors === _errs137){if(typeof data44 === "string"){if(!pattern220.test(data44)){const err0: any = {instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs136 === errors;valid41 = valid41 || _valid0;const _errs139: any = errors;if(data44 !== null){const err2: any = {instancePath:instancePath+"/previousHash",schemaPath:"#/oneOf/5/properties/previousHash/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs139 === errors;valid41 = valid41 || _valid0;if(!valid41){const err3: any = {instancePath:instancePath+"/previousHash",schemaPath:"#/oneOf/5/properties/previousHash/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2225.errors = vErrors;return false;}else {errors = _errs135;if(vErrors !== null){if(_errs135){vErrors.length = _errs135;}else {vErrors = null;}}}var valid40: any = _errs134 === errors;}else {var valid40: any = true;}if(valid40){if(data.issuedAt !== undefined){let data45: any = data.issuedAt;const _errs141: any = errors;const _errs142: any = errors;if(errors === _errs142){if(typeof data45 === "string"){if(!pattern5.test(data45)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid40: any = _errs141 === errors;}else {var valid40: any = true;}if(valid40){if(data.signatures !== undefined){let data46: any = data.signatures;const _errs144: any = errors;if(errors === _errs144){if(Array.isArray(data46)){if(data46.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/5/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid44: any = true;const len5: any = data46.length;for(let i5=0; i5<len5; i5++){const _errs146: any = errors;if(!(validate403.call(this, data46[i5], {instancePath:instancePath+"/signatures/" + i5,parentData:data46,parentDataProperty:i5,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid44: any = _errs146 === errors;if(!valid44){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/5/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid40: any = _errs144 === errors;}else {var valid40: any = true;}if(valid40){if(data.machineId !== undefined){let data48: any = data.machineId;const _errs147: any = errors;const _errs148: any = errors;if(errors === _errs148){if(typeof data48 === "string"){if(func1(data48) > 256){validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data48) < 1){validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid40: any = _errs147 === errors;}else {var valid40: any = true;}if(valid40){if(data.identityKey !== undefined){let data49: any = data.identityKey;const _errs151: any = errors;const _errs152: any = errors;if(errors === _errs152){if(data49 && typeof data49 == "object" && !Array.isArray(data49)){const _errs155: any = errors;for(const key12 in data49){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/MachineIdentityKey/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key12}}];return false;break;}if(_errs155 === errors){const tag3: any = data49.algorithm;if(typeof tag3 == "string"){if(tag3 === "ed25519"){const _errs156: any = errors;if(errors === _errs156){if(data49 && typeof data49 == "object" && !Array.isArray(data49)){let missing9: any;if(((data49.algorithm === undefined) && (missing9 = "algorithm")) || ((data49.publicKey === undefined) && (missing9 = "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/MachineIdentityKey/oneOf/0/required",keyword:"required",params:{missingProperty: missing9}}];return false;}else {const _errs158: any = errors;for(const key13 in data49){if(!((key13 === "algorithm") || (key13 === "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/MachineIdentityKey/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key13}}];return false;break;}}if(_errs158 === errors){if(data49.algorithm !== undefined){let data50: any = data49.algorithm;const _errs159: any = errors;if(typeof data50 !== "string"){validate2225.errors = [{instancePath:instancePath+"/identityKey/algorithm",schemaPath:"#/$defs/MachineIdentityKey/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("ed25519" !== data50){validate2225.errors = [{instancePath:instancePath+"/identityKey/algorithm",schemaPath:"#/$defs/MachineIdentityKey/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "ed25519"}}];return false;}var valid49: any = _errs159 === errors;}else {var valid49: any = true;}if(valid49){if(data49.publicKey !== undefined){let data51: any = data49.publicKey;const _errs161: any = errors;if(errors === _errs161){if(typeof data51 === "string"){if(!pattern445.test(data51)){validate2225.errors = [{instancePath:instancePath+"/identityKey/publicKey",schemaPath:"#/$defs/MachineIdentityKey/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey/publicKey",schemaPath:"#/$defs/MachineIdentityKey/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid49: any = _errs161 === errors;}else {var valid49: any = true;}}}}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/MachineIdentityKey/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/MachineIdentityKey/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag3}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/MachineIdentityKey/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag3}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/identityKey",schemaPath:"#/$defs/MachineIdentityKey/type",keyword:"type",params:{type: "object"}}];return false;}}var valid40: any = _errs151 === errors;}else {var valid40: any = true;}if(valid40){if(data.channelKey !== undefined){let data52: any = data.channelKey;const _errs163: any = errors;const _errs164: any = errors;if(errors === _errs164){if(data52 && typeof data52 == "object" && !Array.isArray(data52)){const _errs167: any = errors;for(const key14 in data52){validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key14}}];return false;break;}if(_errs167 === errors){const tag4: any = data52.algorithm;if(typeof tag4 == "string"){if(tag4 === "x25519"){const _errs168: any = errors;if(errors === _errs168){if(data52 && typeof data52 == "object" && !Array.isArray(data52)){let missing10: any;if(((data52.algorithm === undefined) && (missing10 = "algorithm")) || ((data52.publicKey === undefined) && (missing10 = "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/required",keyword:"required",params:{missingProperty: missing10}}];return false;}else {const _errs170: any = errors;for(const key15 in data52){if(!((key15 === "algorithm") || (key15 === "publicKey"))){validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key15}}];return false;break;}}if(_errs170 === errors){if(data52.algorithm !== undefined){let data53: any = data52.algorithm;const _errs171: any = errors;if(typeof data53 !== "string"){validate2225.errors = [{instancePath:instancePath+"/channelKey/algorithm",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/algorithm/type",keyword:"type",params:{type: "string"}}];return false;}if("x25519" !== data53){validate2225.errors = [{instancePath:instancePath+"/channelKey/algorithm",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/algorithm/const",keyword:"const",params:{allowedValue: "x25519"}}];return false;}var valid53: any = _errs171 === errors;}else {var valid53: any = true;}if(valid53){if(data52.publicKey !== undefined){let data54: any = data52.publicKey;const _errs173: any = errors;if(errors === _errs173){if(typeof data54 === "string"){if(!pattern445.test(data54)){validate2225.errors = [{instancePath:instancePath+"/channelKey/publicKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/publicKey/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9+/]{43}=$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey/publicKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/properties/publicKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid53: any = _errs173 === errors;}else {var valid53: any = true;}}}}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "algorithm", tagValue: tag4}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/discriminator",keyword:"discriminator",params:{error: "tag", tag: "algorithm", tagValue: tag4}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/channelKey",schemaPath:"#/$defs/ChannelPublicKey/type",keyword:"type",params:{type: "object"}}];return false;}}var valid40: any = _errs163 === errors;}else {var valid40: any = true;}if(valid40){if(data.name !== undefined){let data55: any = data.name;const _errs175: any = errors;if(errors === _errs175){if(typeof data55 === "string"){if(func1(data55) > 256){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data55) < 1){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data55)){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/5/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid40: any = _errs175 === errors;}else {var valid40: any = true;}}}}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "machine.renamed"){const _errs177: any = errors;if(errors === _errs177){if(data && typeof data == "object" && !Array.isArray(data)){let missing11: any;if(((((((data.kind === undefined) && (missing11 = "kind")) || ((data.previousHash === undefined) && (missing11 = "previousHash"))) || ((data.issuedAt === undefined) && (missing11 = "issuedAt"))) || ((data.signatures === undefined) && (missing11 = "signatures"))) || ((data.machineId === undefined) && (missing11 = "machineId"))) || ((data.name === undefined) && (missing11 = "name"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing11}}];return false;}else {const _errs179: any = errors;for(const key16 in data){if(!((((((key16 === "kind") || (key16 === "previousHash")) || (key16 === "issuedAt")) || (key16 === "signatures")) || (key16 === "machineId")) || (key16 === "name"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key16}}];return false;break;}}if(_errs179 === errors){if(data.kind !== undefined){let data56: any = data.kind;const _errs180: any = errors;if(typeof data56 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("machine.renamed" !== data56){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "machine.renamed"}}];return false;}var valid55: any = _errs180 === errors;}else {var valid55: any = true;}if(valid55){if(data.previousHash !== undefined){let data57: any = data.previousHash;const _errs182: any = errors;const _errs183: any = errors;if(errors === _errs183){if(typeof data57 === "string"){if(!pattern220.test(data57)){validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid55: any = _errs182 === errors;}else {var valid55: any = true;}if(valid55){if(data.issuedAt !== undefined){let data58: any = data.issuedAt;const _errs185: any = errors;const _errs186: any = errors;if(errors === _errs186){if(typeof data58 === "string"){if(!pattern5.test(data58)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid55: any = _errs185 === errors;}else {var valid55: any = true;}if(valid55){if(data.signatures !== undefined){let data59: any = data.signatures;const _errs188: any = errors;if(errors === _errs188){if(Array.isArray(data59)){if(data59.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/6/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid58: any = true;const len6: any = data59.length;for(let i6=0; i6<len6; i6++){const _errs190: any = errors;if(!(validate403.call(this, data59[i6], {instancePath:instancePath+"/signatures/" + i6,parentData:data59,parentDataProperty:i6,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid58: any = _errs190 === errors;if(!valid58){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/6/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid55: any = _errs188 === errors;}else {var valid55: any = true;}if(valid55){if(data.machineId !== undefined){let data61: any = data.machineId;const _errs191: any = errors;const _errs192: any = errors;if(errors === _errs192){if(typeof data61 === "string"){if(func1(data61) > 256){validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data61) < 1){validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid55: any = _errs191 === errors;}else {var valid55: any = true;}if(valid55){if(data.name !== undefined){let data62: any = data.name;const _errs195: any = errors;if(errors === _errs195){if(typeof data62 === "string"){if(func1(data62) > 256){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data62) < 1){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data62)){validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2225.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/6/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid55: any = _errs195 === errors;}else {var valid55: any = true;}}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "machine.removed"){const _errs197: any = errors;if(errors === _errs197){if(data && typeof data == "object" && !Array.isArray(data)){let missing12: any;if((((((data.kind === undefined) && (missing12 = "kind")) || ((data.previousHash === undefined) && (missing12 = "previousHash"))) || ((data.issuedAt === undefined) && (missing12 = "issuedAt"))) || ((data.signatures === undefined) && (missing12 = "signatures"))) || ((data.machineId === undefined) && (missing12 = "machineId"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing12}}];return false;}else {const _errs199: any = errors;for(const key17 in data){if(!(((((key17 === "kind") || (key17 === "previousHash")) || (key17 === "issuedAt")) || (key17 === "signatures")) || (key17 === "machineId"))){validate2225.errors = [{instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key17}}];return false;break;}}if(_errs199 === errors){if(data.kind !== undefined){let data63: any = data.kind;const _errs200: any = errors;if(typeof data63 !== "string"){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("machine.removed" !== data63){validate2225.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/const",keyword:"const",params:{allowedValue: "machine.removed"}}];return false;}var valid61: any = _errs200 === errors;}else {var valid61: any = true;}if(valid61){if(data.previousHash !== undefined){let data64: any = data.previousHash;const _errs202: any = errors;const _errs203: any = errors;if(errors === _errs203){if(typeof data64 === "string"){if(!pattern220.test(data64)){validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/previousHash",schemaPath:"#/$defs/TrustStatementHash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid61: any = _errs202 === errors;}else {var valid61: any = true;}if(valid61){if(data.issuedAt !== undefined){let data65: any = data.issuedAt;const _errs205: any = errors;const _errs206: any = errors;if(errors === _errs206){if(typeof data65 === "string"){if(!pattern5.test(data65)){validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2225.errors = [{instancePath:instancePath+"/issuedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid61: any = _errs205 === errors;}else {var valid61: any = true;}if(valid61){if(data.signatures !== undefined){let data66: any = data.signatures;const _errs208: any = errors;if(errors === _errs208){if(Array.isArray(data66)){if(data66.length < 1){validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/7/properties/signatures/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid64: any = true;const len7: any = data66.length;for(let i7=0; i7<len7; i7++){const _errs210: any = errors;if(!(validate403.call(this, data66[i7], {instancePath:instancePath+"/signatures/" + i7,parentData:data66,parentDataProperty:i7,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate403.errors : vErrors.concat(validate403.errors);errors = vErrors.length;}var valid64: any = _errs210 === errors;if(!valid64){break;}}}}else {validate2225.errors = [{instancePath:instancePath+"/signatures",schemaPath:"#/oneOf/7/properties/signatures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid61: any = _errs208 === errors;}else {var valid61: any = true;}if(valid61){if(data.machineId !== undefined){let data68: any = data.machineId;const _errs211: any = errors;const _errs212: any = errors;if(errors === _errs212){if(typeof data68 === "string"){if(func1(data68) > 256){validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data68) < 1){validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2225.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid61: any = _errs211 === errors;}else {var valid61: any = true;}}}}}}}}else {validate2225.errors = [{instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2225.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2225.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate2225.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2225.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2225.errors = null as any[] | null;
// prettier-ignore
validate2225.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2235(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustStatementHash {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2235.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern220.test(data)){validate2235.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate2235.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2235.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2235.errors = null as any[] | null;
// prettier-ignore
validate2235.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2236(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TrustStatementSignature {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2236.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2236.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.signer;if(typeof tag0 == "string"){if(tag0 === "device"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.signer === undefined) && (missing0 = "signer")) || ((data.deviceId === undefined) && (missing0 = "deviceId"))) || ((data.signature === undefined) && (missing0 = "signature"))){validate2236.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((key1 === "signer") || (key1 === "deviceId")) || (key1 === "signature"))){validate2236.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.signer !== undefined){let data0: any = data.signer;const _errs6: any = errors;if(typeof data0 !== "string"){validate2236.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("device" !== data0){validate2236.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/0/properties/signer/const",keyword:"const",params:{allowedValue: "device"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.deviceId !== undefined){let data1: any = data.deviceId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(func1(data1) > 256){validate2236.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data1)){validate2236.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2236.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.signature !== undefined){let data2: any = data.signature;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(func1(data2) > 4096){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern436.test(data2)){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$"}}];return false;}}}}else {validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/0/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}else {validate2236.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "machine"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.signer === undefined) && (missing1 = "signer")) || ((data.machineId === undefined) && (missing1 = "machineId"))) || ((data.signature === undefined) && (missing1 = "signature"))){validate2236.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(((key2 === "signer") || (key2 === "machineId")) || (key2 === "signature"))){validate2236.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.signer !== undefined){let data3: any = data.signer;const _errs17: any = errors;if(typeof data3 !== "string"){validate2236.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("machine" !== data3){validate2236.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/1/properties/signer/const",keyword:"const",params:{allowedValue: "machine"}}];return false;}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.machineId !== undefined){let data4: any = data.machineId;const _errs19: any = errors;const _errs20: any = errors;if(errors === _errs20){if(typeof data4 === "string"){if(func1(data4) > 256){validate2236.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate2236.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2236.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.signature !== undefined){let data5: any = data.signature;const _errs23: any = errors;if(errors === _errs23){if(typeof data5 === "string"){if(func1(data5) > 4096){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern436.test(data5)){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$"}}];return false;}}}}else {validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/1/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs23 === errors;}else {var valid5: any = true;}}}}}}else {validate2236.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "passkey"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((data.signer === undefined) && (missing2 = "signer")) || ((data.passkeyId === undefined) && (missing2 = "passkeyId"))) || ((data.authenticatorData === undefined) && (missing2 = "authenticatorData"))) || ((data.clientDataJson === undefined) && (missing2 = "clientDataJson"))) || ((data.signature === undefined) && (missing2 = "signature"))) || ((data.challengeNonce === undefined) && (missing2 = "challengeNonce"))){validate2236.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs27: any = errors;for(const key3 in data){if(!((((((key3 === "signer") || (key3 === "passkeyId")) || (key3 === "authenticatorData")) || (key3 === "clientDataJson")) || (key3 === "signature")) || (key3 === "challengeNonce"))){validate2236.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs27 === errors){if(data.signer !== undefined){let data6: any = data.signer;const _errs28: any = errors;if(typeof data6 !== "string"){validate2236.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/type",keyword:"type",params:{type: "string"}}];return false;}if("passkey" !== data6){validate2236.errors = [{instancePath:instancePath+"/signer",schemaPath:"#/oneOf/2/properties/signer/const",keyword:"const",params:{allowedValue: "passkey"}}];return false;}var valid8: any = _errs28 === errors;}else {var valid8: any = true;}if(valid8){if(data.passkeyId !== undefined){let data7: any = data.passkeyId;const _errs30: any = errors;if(errors === _errs30){if(typeof data7 === "string"){if(func1(data7) > 1364){validate2236.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data7) < 1){validate2236.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data7)){validate2236.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2236.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/oneOf/2/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}if(valid8){if(data.authenticatorData !== undefined){let data8: any = data.authenticatorData;const _errs32: any = errors;if(errors === _errs32){if(typeof data8 === "string"){if(func1(data8) > 4096){validate2236.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data8) < 1){validate2236.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data8)){validate2236.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2236.errors = [{instancePath:instancePath+"/authenticatorData",schemaPath:"#/oneOf/2/properties/authenticatorData/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs32 === errors;}else {var valid8: any = true;}if(valid8){if(data.clientDataJson !== undefined){let data9: any = data.clientDataJson;const _errs34: any = errors;if(errors === _errs34){if(typeof data9 === "string"){if(func1(data9) > 4096){validate2236.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validate2236.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data9)){validate2236.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2236.errors = [{instancePath:instancePath+"/clientDataJson",schemaPath:"#/oneOf/2/properties/clientDataJson/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs34 === errors;}else {var valid8: any = true;}if(valid8){if(data.signature !== undefined){let data10: any = data.signature;const _errs36: any = errors;if(errors === _errs36){if(typeof data10 === "string"){if(func1(data10) > 4096){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data10) < 1){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern14.test(data10)){validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2236.errors = [{instancePath:instancePath+"/signature",schemaPath:"#/oneOf/2/properties/signature/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs36 === errors;}else {var valid8: any = true;}if(valid8){if(data.challengeNonce !== undefined){let data11: any = data.challengeNonce;const _errs38: any = errors;if(errors === _errs38){if(typeof data11 === "string"){if(func1(data11) > 43){validate2236.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/maxLength",keyword:"maxLength",params:{limit: 43}}];return false;}else {if(func1(data11) < 43){validate2236.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/minLength",keyword:"minLength",params:{limit: 43}}];return false;}else {if(!pattern14.test(data11)){validate2236.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validate2236.errors = [{instancePath:instancePath+"/challengeNonce",schemaPath:"#/oneOf/2/properties/challengeNonce/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs38 === errors;}else {var valid8: any = true;}}}}}}}}}else {validate2236.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2236.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "signer", tagValue: tag0}}];return false;}}else {validate2236.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "signer", tagValue: tag0}}];return false;}}}else {validate2236.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2236.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2236.errors = null as any[] | null;
// prettier-ignore
validate2236.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ChannelPublicKey}. */
export const validateChannelPublicKey: SchemaCheck<ChannelPublicKey> = validate2218;
/** Checks that a value is a {@link DeviceId}. */
export const validateDeviceId: SchemaCheck<DeviceId> = validate2219;
/** Checks that a value is a {@link DeviceRenamedStatement}. */
export const validateDeviceRenamedStatement: SchemaCheck<DeviceRenamedStatement> = validate2220;
/** Checks that a value is a {@link IdentityPublicKey}. */
export const validateIdentityPublicKey: SchemaCheck<IdentityPublicKey> = validate2222;
/** Checks that a value is a {@link MachineIdentityKey}. */
export const validateMachineIdentityKey: SchemaCheck<MachineIdentityKey> = validate2223;
/** Checks that a value is a {@link PasskeyPublicKey}. */
export const validatePasskeyPublicKey: SchemaCheck<PasskeyPublicKey> = validate2224;
/** Checks that a value is a {@link TrustStatement}. */
export const validateTrustStatement: SchemaCheck<TrustStatement> = validate2225;
/** Checks that a value is a {@link TrustStatementHash}. */
export const validateTrustStatementHash: SchemaCheck<TrustStatementHash> = validate2235;
/** Checks that a value is a {@link TrustStatementSignature}. */
export const validateTrustStatementSignature: SchemaCheck<TrustStatementSignature> = validate2236;
