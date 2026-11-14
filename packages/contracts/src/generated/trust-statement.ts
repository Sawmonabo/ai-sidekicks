// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The account's trust, as every machine verifies it: the identity and channel keys, who signed, and the append-only chain of signed statements the control plane keeps and serves.
//
// Trust is the chain, not the control plane. Every machine checks each statement itself and trusts a key only when a path of statements reaches it from its own machine key, so every request that changes who is trusted carries a statement signed by one of the person's own keys rather than asking the control plane to decide.

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

export { validateDeviceId } from "./checks/trust-statement.js";
