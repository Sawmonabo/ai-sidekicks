// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The hosted account's procedures on the control plane: deleting it and exporting what the control plane keeps for the person.

import type { SchemaCheck } from "../schema-check.js";
import { validateAccountExportResponse } from "./checks/account.js";
import { validateEmptyPayload } from "./checks/method-descriptor.js";
import type { DeviceEntry } from "./device.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import type { EmptyPayload } from "./method-descriptor.js";
import type { UserId } from "./session/id.js";

/**
 * The account's own record, as the control plane keeps it.
 */
export interface AccountRecord {
  /**
   * The person.
   */
  userId: UserId;
  /**
   * When the account was made.
   */
  createdAt: WireInstant;
  /**
   * The person's display name.
   */
  displayName: string;
}
/**
 * The account record and its device list; reading them changes nothing.
 */
export interface AccountExportResponse {
  /**
   * The account.
   */
  account: AccountRecord;
  /**
   * Its devices.
   */
  devices: DeviceEntry[];
}

export { validateAccountExportResponse, validateAccountRecord } from "./checks/account.js";

/** The methods of {@link ACCOUNT_METHOD_DESCRIPTORS}, each with its checks. */
export interface AccountMethodDescriptors {
  readonly "account.delete": {
    readonly method: "account.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "account.export": {
    readonly method: "account.export";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<AccountExportResponse>;
  };
}
/** The hosted account's procedures the control plane serves. */
export const ACCOUNT_METHOD_DESCRIPTORS: AccountMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "account.delete": /* @__PURE__ */ Object.freeze({
    method: "account.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
  "account.export": /* @__PURE__ */ Object.freeze({
    method: "account.export",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateAccountExportResponse,
  }),
});
