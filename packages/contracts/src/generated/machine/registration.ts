// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A machine's registration with the control plane, and the requests that rename it, remove it and write the DNS challenge record for its wildcard certificate.

import type {
  MachineIdentityKey,
  MachineRemovedStatement,
  MachineRenamedStatement,
} from "../trust-statement.js";
import type { MachineId } from "./id.js";

/**
 * A challenge record's name: `_acme-challenge.` and then a lower-case domain of two labels or
 * more, within the DNS name bound, so the request can never write any other record.
 */
export type CertificateChallengeName = string;
/**
 * A challenge record's value: the 43 base64url characters of a SHA-256 digest.
 */
export type CertificateChallengeValue = string;

/**
 * The service's registration at each start: the machine's id, identity key, own name, platform
 * and the service's version. The control plane accepts it only for the key enrolled at sign-in,
 * and refreshes that machine's row.
 */
export interface MachineRegisterRequest {
  /**
   * The machine.
   */
  machineId: MachineId;
  /**
   * The machine's identity key.
   */
  identityKey: MachineIdentityKey;
  /**
   * The machine's own name.
   */
  name: string;
  /**
   * The machine's platform, such as `macOS 15.6`.
   */
  platform: string;
  /**
   * The service's version.
   */
  serviceVersion: string;
}
/**
 * A rename, as the `machine.renamed` statement a trusted key signs.
 */
export interface MachineRenameRequest {
  /**
   * The signed statement.
   */
  statement: MachineRenamedStatement;
}
/**
 * A removal, as the `machine.removed` statement a trusted key signs. The machine comes back
 * only by being linked again, under a new identity key and its same id.
 */
export interface MachineRemoveRequest {
  /**
   * The signed statement.
   */
  statement: MachineRemovedStatement;
}
/**
 * The TXT record an ACME DNS challenge asks for: its name, under `_acme-challenge.`, and its
 * value. The relay writes it only for a machine that proves its key, and only for the minutes of
 * the challenge.
 */
export interface MachineCertificateChallengeUpdateRequest {
  /**
   * The record's name.
   */
  name: CertificateChallengeName;
  /**
   * The record's value.
   */
  value: CertificateChallengeValue;
}
