// The account's trust, as every machine verifies it: the identity and channel keys,
// who signed, and the append-only chain of signed statements the control plane
// keeps and serves.
//
// Trust is the chain, not the control plane. Every machine checks each statement
// itself and trusts a key only when a path of statements reaches it from its own
// machine key, so every request that changes who is trusted carries a statement
// signed by one of the person's own keys rather than asking the control plane to
// decide.
import { z } from "zod";

import { decodedByteLength } from "./internal/base64.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import { DEVICE_ID_MAX_LEN } from "./presence.js";
import { wireFreeFormString } from "./session.js";

/** The longest name a machine or a device carries: the one name every other device shows. */
export const MACHINE_OR_DEVICE_NAME_MAX_LEN = 256;
/** The longest platform description, such as `iPhone`, `Chrome on Windows` or `macOS 15.6`. */
export const PLATFORM_DESCRIPTION_MAX_LEN = 128;
/** WebAuthn caps a credential id at 1,023 bytes, which is 1,364 base64url characters. */
export const PASSKEY_ID_MAX_LEN = 1364;
/** The longest encoded signature, WebAuthn assertion part or linking proof. */
const SIGNATURE_PART_MAX_LEN = 4096;

// --------------------------------------------------------------------------
// Ids
// --------------------------------------------------------------------------

/** The control plane's id for one of the person's phones or browsers. Opaque to every client. */
export type DeviceId = string & { readonly __brand: "DeviceId" };
/** Parses a {@link DeviceId}: a non-empty string up to the device-id bound presence uses. */
export const DeviceIdSchema: z.ZodType<DeviceId, DeviceId> = z
  .string()
  .min(1)
  .max(DEVICE_ID_MAX_LEN)
  .brand<"DeviceId">() as unknown as z.ZodType<DeviceId, DeviceId>;

/** A passkey's WebAuthn credential id, base64url as the platform hands it over. */
export const PasskeyIdSchema: z.ZodType<string, string> = z
  .base64url()
  .min(1)
  .max(PASSKEY_ID_MAX_LEN);

/**
 * The SHA-256 of a statement's canonical bytes (RFC 8785), as 64 lowercase hex
 * characters. The chain names each statement's predecessor by it, and a channel open
 * exchanges the newest one as the chain head.
 */
export const TrustStatementHashSchema: z.ZodType<string, string> = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "a statement hash is 64 lowercase hex characters");

// --------------------------------------------------------------------------
// Keys
// --------------------------------------------------------------------------

/**
 * The algorithms an identity key may use. A phone's Secure Enclave holds only
 * P-256, and a machine's service key is Ed25519, so every public key carries its tag.
 */
export const IDENTITY_KEY_ALGORITHMS = ["p256", "ed25519"] as const;
/** One identity-key algorithm. */
export type IdentityKeyAlgorithm = (typeof IDENTITY_KEY_ALGORITHMS)[number];

/**
 * The public half of a machine's, a device's or a passkey's identity key, standard
 * base64. An Ed25519 key is 32 bytes; a P-256 key is its 65-byte uncompressed point,
 * the form WebCrypto's raw export gives.
 */
export interface IdentityPublicKey {
  algorithm: IdentityKeyAlgorithm;
  publicKey: string;
}
const IDENTITY_KEY_BYTES: Readonly<Record<IdentityKeyAlgorithm, number>> = {
  p256: 65,
  ed25519: 32,
};
/** Parses an {@link IdentityPublicKey}; the key's length must match its algorithm. */
export const IdentityPublicKeySchema: z.ZodType<IdentityPublicKey, IdentityPublicKey> = z
  .object({ algorithm: z.enum(IDENTITY_KEY_ALGORITHMS), publicKey: z.base64() })
  .strict()
  .superRefine((key, ctx) => {
    if (decodedByteLength(key.publicKey) !== IDENTITY_KEY_BYTES[key.algorithm]) {
      ctx.addIssue({
        code: "custom",
        path: ["publicKey"],
        message: `a ${key.algorithm} public key is ${IDENTITY_KEY_BYTES[key.algorithm]} bytes`,
      });
    }
  });

/** A machine's identity key: the service's Ed25519 key, the one key a machine has. */
export interface MachineIdentityKey {
  algorithm: "ed25519";
  publicKey: string;
}
/** Parses a {@link MachineIdentityKey}. */
export const MachineIdentityKeySchema: z.ZodType<MachineIdentityKey, MachineIdentityKey> = z
  .object({
    algorithm: z.literal("ed25519"),
    publicKey: z
      .base64()
      .refine((value) => decodedByteLength(value) === 32, "an ed25519 public key is 32 bytes"),
  })
  .strict();

/**
 * The public half of the X25519 key a machine or device runs its encrypted channel
 * with, 32 bytes in standard base64. The identity key certifies it in the statement
 * that trusts that identity, so the chain stays the one record of trust.
 */
export interface ChannelPublicKey {
  algorithm: "x25519";
  publicKey: string;
}
/** Parses a {@link ChannelPublicKey}. */
export const ChannelPublicKeySchema: z.ZodType<ChannelPublicKey, ChannelPublicKey> = z
  .object({
    algorithm: z.literal("x25519"),
    publicKey: z
      .base64()
      .refine((value) => decodedByteLength(value) === 32, "an x25519 public key is 32 bytes"),
  })
  .strict();

// --------------------------------------------------------------------------
// Who signed
// --------------------------------------------------------------------------

/** The key behind a statement or an entry: a device's, a machine's or a passkey's. */
export type TrustSigner =
  | { signer: "device"; deviceId: DeviceId }
  | { signer: "runtimenode"; nodeId: NodeId }
  | { signer: "passkey"; passkeyId: string };
/** Parses a {@link TrustSigner}. */
export const TrustSignerSchema: z.ZodType<TrustSigner, TrustSigner> = z.discriminatedUnion(
  "signer",
  [
    z.object({ signer: z.literal("device"), deviceId: DeviceIdSchema }).strict(),
    z.object({ signer: z.literal("runtimenode"), nodeId: NodeIdSchema }).strict(),
    z.object({ signer: z.literal("passkey"), passkeyId: PasskeyIdSchema }).strict(),
  ],
);

/**
 * One signature over a statement's canonical bytes without its `signatures`. A
 * device or machine key signs directly; a passkey signs through a WebAuthn
 * assertion, whose three parts arrive base64url as the platform returns them.
 */
export type TrustStatementSignature =
  | { signer: "device"; deviceId: DeviceId; signature: string }
  | { signer: "runtimenode"; nodeId: NodeId; signature: string }
  | {
      signer: "passkey";
      passkeyId: string;
      authenticatorData: string;
      clientDataJson: string;
      signature: string;
    };
const SignatureBytesSchema = z.base64().min(1).max(SIGNATURE_PART_MAX_LEN);
const WebAuthnPartSchema = z.base64url().min(1).max(SIGNATURE_PART_MAX_LEN);
/** Parses a {@link TrustStatementSignature}. */
export const TrustStatementSignatureSchema: z.ZodType<
  TrustStatementSignature,
  TrustStatementSignature
> = z.discriminatedUnion("signer", [
  z
    .object({
      signer: z.literal("device"),
      deviceId: DeviceIdSchema,
      signature: SignatureBytesSchema,
    })
    .strict(),
  z
    .object({
      signer: z.literal("runtimenode"),
      nodeId: NodeIdSchema,
      signature: SignatureBytesSchema,
    })
    .strict(),
  z
    .object({
      signer: z.literal("passkey"),
      passkeyId: PasskeyIdSchema,
      authenticatorData: WebAuthnPartSchema,
      clientDataJson: WebAuthnPartSchema,
      signature: WebAuthnPartSchema,
    })
    .strict(),
]);

// --------------------------------------------------------------------------
// The statement chain
// --------------------------------------------------------------------------

/**
 * The kinds of statement in the account's chain. Each records a fact, named subject
 * first and past tense, and the event that announces a statement carries its kind as
 * its name.
 */
export const TRUST_STATEMENT_KINDS = [
  "device.linked",
  "device.renamed",
  "device.revoked",
  "passkey.added",
  "passkey.removed",
  "runtimenode.added",
  "runtimenode.renamed",
  "runtimenode.removed",
  "runtimenode.key_rotated",
] as const;
/** One statement kind. */
export type TrustStatementKind = (typeof TRUST_STATEMENT_KINDS)[number];

/**
 * What every statement carries: the hash of the statement before it, when it was
 * signed, and at least one signature. Only the chain's first statement, the
 * `runtimenode.added` the person's first machine signs itself, has no predecessor.
 */
export interface TrustStatementBase {
  previousHash: string;
  issuedAt: string;
  signatures: TrustStatementSignature[];
}

/** A device joins: its identity key, its channel key, its name and its platform. */
export interface DeviceLinkedStatement extends TrustStatementBase {
  kind: "device.linked";
  deviceId: DeviceId;
  identityKey: IdentityPublicKey;
  channelKey: ChannelPublicKey;
  name: string;
  platform: string;
}
/** A device's one name changes. */
export interface DeviceRenamedStatement extends TrustStatementBase {
  kind: "device.renamed";
  deviceId: DeviceId;
  name: string;
}
/** A device's key ends here; what it signed before stands. */
export interface DeviceRevokedStatement extends TrustStatementBase {
  kind: "device.revoked";
  deviceId: DeviceId;
}
/** A passkey joins, with the platform that holds it. */
export interface PasskeyAddedStatement extends TrustStatementBase {
  kind: "passkey.added";
  passkeyId: string;
  publicKey: IdentityPublicKey;
  platform: string;
}
/** A passkey's key ends here. */
export interface PasskeyRemovedStatement extends TrustStatementBase {
  kind: "passkey.removed";
  passkeyId: string;
}
/**
 * A machine joins, or a removed machine comes back under its same id with a new key.
 * The person's first machine opens the chain with this statement, so here alone
 * `previousHash` is `null`.
 */
export interface RuntimeNodeAddedStatement extends Omit<TrustStatementBase, "previousHash"> {
  kind: "runtimenode.added";
  previousHash: string | null;
  nodeId: NodeId;
  identityKey: MachineIdentityKey;
  channelKey: ChannelPublicKey;
  name: string;
}
/** A machine's one name changes. */
export interface RuntimeNodeRenamedStatement extends TrustStatementBase {
  kind: "runtimenode.renamed";
  nodeId: NodeId;
  name: string;
}
/** A machine's key ends here; its store, sessions and id stay. */
export interface RuntimeNodeRemovedStatement extends TrustStatementBase {
  kind: "runtimenode.removed";
  nodeId: NodeId;
}
/**
 * A machine's new identity and channel keys replace its old ones. Signed by the old
 * key and the new one, so every device moves its pin without linking again.
 */
export interface RuntimeNodeKeyRotatedStatement extends TrustStatementBase {
  kind: "runtimenode.key_rotated";
  nodeId: NodeId;
  identityKey: MachineIdentityKey;
  channelKey: ChannelPublicKey;
}

/** One statement of the account's chain. */
export type TrustStatement =
  | DeviceLinkedStatement
  | DeviceRenamedStatement
  | DeviceRevokedStatement
  | PasskeyAddedStatement
  | PasskeyRemovedStatement
  | RuntimeNodeAddedStatement
  | RuntimeNodeRenamedStatement
  | RuntimeNodeRemovedStatement
  | RuntimeNodeKeyRotatedStatement;

const NameSchema = wireFreeFormString(MACHINE_OR_DEVICE_NAME_MAX_LEN, "name");
const PlatformSchema = wireFreeFormString(PLATFORM_DESCRIPTION_MAX_LEN, "platform");
const IsoTimeSchema = z.iso.datetime({ offset: true });
const statementBase = {
  previousHash: TrustStatementHashSchema,
  issuedAt: IsoTimeSchema,
  signatures: z.array(TrustStatementSignatureSchema).min(1),
};

const deviceLinkedStatementObject = z
  .object({
    kind: z.literal("device.linked"),
    ...statementBase,
    deviceId: DeviceIdSchema,
    identityKey: IdentityPublicKeySchema,
    channelKey: ChannelPublicKeySchema,
    name: NameSchema,
    platform: PlatformSchema,
  })
  .strict();
const deviceRenamedStatementObject = z
  .object({
    kind: z.literal("device.renamed"),
    ...statementBase,
    deviceId: DeviceIdSchema,
    name: NameSchema,
  })
  .strict();
const deviceRevokedStatementObject = z
  .object({ kind: z.literal("device.revoked"), ...statementBase, deviceId: DeviceIdSchema })
  .strict();
const passkeyAddedStatementObject = z
  .object({
    kind: z.literal("passkey.added"),
    ...statementBase,
    passkeyId: PasskeyIdSchema,
    publicKey: IdentityPublicKeySchema,
    platform: PlatformSchema,
  })
  .strict();
const passkeyRemovedStatementObject = z
  .object({ kind: z.literal("passkey.removed"), ...statementBase, passkeyId: PasskeyIdSchema })
  .strict();
const runtimeNodeAddedStatementObject = z
  .object({
    kind: z.literal("runtimenode.added"),
    ...statementBase,
    previousHash: TrustStatementHashSchema.nullable(),
    nodeId: NodeIdSchema,
    identityKey: MachineIdentityKeySchema,
    channelKey: ChannelPublicKeySchema,
    name: NameSchema,
  })
  .strict();
const runtimeNodeRenamedStatementObject = z
  .object({
    kind: z.literal("runtimenode.renamed"),
    ...statementBase,
    nodeId: NodeIdSchema,
    name: NameSchema,
  })
  .strict();
const runtimeNodeRemovedStatementObject = z
  .object({ kind: z.literal("runtimenode.removed"), ...statementBase, nodeId: NodeIdSchema })
  .strict();
const runtimeNodeKeyRotatedStatementObject = z
  .object({
    kind: z.literal("runtimenode.key_rotated"),
    ...statementBase,
    // Signed by the machine's old key and its new one: a rotation one key signs alone
    // would let a stolen key move every device's pin.
    signatures: z.array(TrustStatementSignatureSchema).min(2),
    nodeId: NodeIdSchema,
    identityKey: MachineIdentityKeySchema,
    channelKey: ChannelPublicKeySchema,
  })
  .strict();

/** Parses a {@link DeviceLinkedStatement}. */
export const DeviceLinkedStatementSchema: z.ZodType<DeviceLinkedStatement, DeviceLinkedStatement> =
  deviceLinkedStatementObject;
/** Parses a {@link DeviceRenamedStatement}. */
export const DeviceRenamedStatementSchema: z.ZodType<
  DeviceRenamedStatement,
  DeviceRenamedStatement
> = deviceRenamedStatementObject;
/** Parses a {@link DeviceRevokedStatement}. */
export const DeviceRevokedStatementSchema: z.ZodType<
  DeviceRevokedStatement,
  DeviceRevokedStatement
> = deviceRevokedStatementObject;
/** Parses a {@link RuntimeNodeRenamedStatement}. */
export const RuntimeNodeRenamedStatementSchema: z.ZodType<
  RuntimeNodeRenamedStatement,
  RuntimeNodeRenamedStatement
> = runtimeNodeRenamedStatementObject;
/** Parses a {@link RuntimeNodeRemovedStatement}. */
export const RuntimeNodeRemovedStatementSchema: z.ZodType<
  RuntimeNodeRemovedStatement,
  RuntimeNodeRemovedStatement
> = runtimeNodeRemovedStatementObject;

/** Parses any {@link TrustStatement}, by its kind. */
export const TrustStatementSchema: z.ZodType<TrustStatement, TrustStatement> = z.discriminatedUnion(
  "kind",
  [
    deviceLinkedStatementObject,
    deviceRenamedStatementObject,
    deviceRevokedStatementObject,
    passkeyAddedStatementObject,
    passkeyRemovedStatementObject,
    runtimeNodeAddedStatementObject,
    runtimeNodeRenamedStatementObject,
    runtimeNodeRemovedStatementObject,
    runtimeNodeKeyRotatedStatementObject,
  ],
);
