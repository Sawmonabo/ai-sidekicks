// The hosted account's procedures on the control plane. Deleting the account
// removes every row the control plane keeps for it and signs this machine out; a
// machine's own data is erased only by its own erase, never by deleting the account.
// Exporting it returns what the control plane keeps for the person, which the data
// export writes as `hosted-account.json`.
import { z } from "zod";

import {
  DeviceEntrySchema,
  EmptyAcknowledgementSchema,
  type DeviceEntry,
  type EmptyAcknowledgement,
} from "./device.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { UserIdSchema, wireUncappedFreeFormString, type UserId } from "./session.js";

/** `account.delete` takes nothing: the account is the caller's. */
export type AccountDeleteRequest = Record<string, never>;
/** Parses an {@link AccountDeleteRequest}. */
export const AccountDeleteRequestSchema: z.ZodType<AccountDeleteRequest, AccountDeleteRequest> = z
  .object({})
  .strict();

/** `account.export` takes nothing: the account is the caller's. */
export type AccountExportRequest = Record<string, never>;
/** Parses an {@link AccountExportRequest}. */
export const AccountExportRequestSchema: z.ZodType<AccountExportRequest, AccountExportRequest> = z
  .object({})
  .strict();

/** The account's own record, as the control plane keeps it. */
export interface AccountRecord {
  userId: UserId;
  createdAt: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

/** The account record and its device list; reading them changes nothing. */
export interface AccountExportResponse {
  account: AccountRecord;
  devices: DeviceEntry[];
}
/** Parses an {@link AccountExportResponse}. */
export const AccountExportResponseSchema: z.ZodType<AccountExportResponse> = z
  .object({
    account: z
      .object({
        userId: UserIdSchema,
        createdAt: z.iso.datetime({ offset: true }),
        displayName: wireUncappedFreeFormString("displayName"),
        metadata: z.record(z.string(), z.unknown()),
      })
      .strict(),
    devices: z.array(DeviceEntrySchema),
  })
  .strict();

/** The hosted account's procedures the control plane serves. */
export interface AccountProcedureDescriptors {
  readonly "account.delete": MethodDescriptor<
    "account.delete",
    AccountDeleteRequest,
    EmptyAcknowledgement
  >;
  readonly "account.export": MethodDescriptor<
    "account.export",
    AccountExportRequest,
    AccountExportResponse
  >;
}

/** The hosted account's procedures the control plane serves. */
export const ACCOUNT_PROCEDURE_DESCRIPTORS: AccountProcedureDescriptors = defineMethodDescriptors({
  "account.delete": {
    method: "account.delete",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AccountDeleteRequestSchema,
    responseSchema: EmptyAcknowledgementSchema,
  },
  "account.export": {
    method: "account.export",
    procedureType: "query",
    mutating: false,
    requestSchema: AccountExportRequestSchema,
    responseSchema: AccountExportResponseSchema,
  },
});
