// The hosted account's procedures on the control plane. Deleting the account
// removes every row the control plane keeps for it and signs this machine out; a
// machine's own data is erased only by its own erase, never by deleting the account.
import { z } from "zod";

import { EmptyAcknowledgementSchema, type EmptyAcknowledgement } from "./device.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";

/** `account.delete` takes nothing: the account is the caller's. */
export type AccountDeleteRequest = Record<string, never>;
/** Parses an {@link AccountDeleteRequest}. */
export const AccountDeleteRequestSchema: z.ZodType<AccountDeleteRequest, AccountDeleteRequest> = z
  .object({})
  .strict();

/** The hosted account's procedures the control plane serves. */
export interface AccountProcedureDescriptors {
  readonly "account.delete": MethodDescriptor<
    "account.delete",
    AccountDeleteRequest,
    EmptyAcknowledgement
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
});
