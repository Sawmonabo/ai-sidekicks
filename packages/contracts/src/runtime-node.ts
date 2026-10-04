// The runtime-node contract: a machine's registration with the control plane, and the requests
// that rename it, remove it and write the DNS challenge record for its wildcard certificate.
// "Runtime node" is the backend's word for one of the person's machines. The registration is only
// the control plane's admission record; trust is the statement chain's, so rename and remove each
// carry the statement a trusted key signed.
import { z } from "zod";

import { APP_VERSION_MAX_LEN } from "./device.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "./method-descriptor.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import { wireFreeFormString } from "./session.js";
import {
  MACHINE_OR_DEVICE_NAME_MAX_LEN,
  MachineIdentityKeySchema,
  PLATFORM_DESCRIPTION_MAX_LEN,
  RuntimeNodeRemovedStatementSchema,
  RuntimeNodeRenamedStatementSchema,
  type MachineIdentityKey,
  type RuntimeNodeRemovedStatement,
  type RuntimeNodeRenamedStatement,
} from "./trust-statement.js";

/** The longest DNS name, per RFC 1035. */
const DNS_NAME_MAX_LEN = 253;

/**
 * The service's registration at each start: the machine's id, identity key, own name, platform
 * and the service's version. The control plane accepts it only for the key enrolled at sign-in,
 * and refreshes that machine's row.
 */
export interface RuntimeNodeRegisterRequest {
  nodeId: NodeId;
  identityKey: MachineIdentityKey;
  name: string;
  platform: string;
  serviceVersion: string;
}
/** Parses a {@link RuntimeNodeRegisterRequest}. */
export const RuntimeNodeRegisterRequestSchema: z.ZodType<
  RuntimeNodeRegisterRequest,
  RuntimeNodeRegisterRequest
> = z
  .object({
    nodeId: NodeIdSchema,
    identityKey: MachineIdentityKeySchema,
    name: wireFreeFormString(MACHINE_OR_DEVICE_NAME_MAX_LEN, "name"),
    platform: wireFreeFormString(PLATFORM_DESCRIPTION_MAX_LEN, "platform"),
    serviceVersion: wireFreeFormString(APP_VERSION_MAX_LEN, "serviceVersion"),
  })
  .strict();

/** A rename, as the `runtimenode.renamed` statement a trusted key signs. */
export interface RuntimeNodeRenameRequest {
  statement: RuntimeNodeRenamedStatement;
}
/** Parses a {@link RuntimeNodeRenameRequest}. */
export const RuntimeNodeRenameRequestSchema: z.ZodType<
  RuntimeNodeRenameRequest,
  RuntimeNodeRenameRequest
> = z.object({ statement: RuntimeNodeRenamedStatementSchema }).strict();

/**
 * A removal, as the `runtimenode.removed` statement a trusted key signs. The machine comes back
 * only by being linked again, under a new identity key and its same id.
 */
export interface RuntimeNodeRemoveRequest {
  statement: RuntimeNodeRemovedStatement;
}
/** Parses a {@link RuntimeNodeRemoveRequest}. */
export const RuntimeNodeRemoveRequestSchema: z.ZodType<
  RuntimeNodeRemoveRequest,
  RuntimeNodeRemoveRequest
> = z.object({ statement: RuntimeNodeRemovedStatementSchema }).strict();

/**
 * The TXT record an ACME DNS challenge asks for: its name, under `_acme-challenge.`, and its
 * value, the 43-character base64url SHA-256 digest. The relay writes it only for a machine that
 * proves its key, and only for the minutes of the challenge.
 */
export interface RuntimeNodeCertificateChallengeSetRequest {
  name: string;
  value: string;
}
/**
 * Parses a {@link RuntimeNodeCertificateChallengeSetRequest}. The name must be a challenge name,
 * so the request can never write any other record.
 */
export const RuntimeNodeCertificateChallengeSetRequestSchema: z.ZodType<
  RuntimeNodeCertificateChallengeSetRequest,
  RuntimeNodeCertificateChallengeSetRequest
> = z
  .object({
    name: z
      .string()
      .max(DNS_NAME_MAX_LEN)
      .regex(
        /^_acme-challenge\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
        "a challenge record is named _acme-challenge.<domain>",
      ),
    value: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "a challenge value is 43 base64url characters"),
  })
  .strict();

/** The runtime-node procedures the control plane serves, keyed by method name. */
export interface RuntimeNodeProcedureDescriptors {
  readonly "runtimenode.register": MethodDescriptor<
    "runtimenode.register",
    RuntimeNodeRegisterRequest,
    EmptyPayload
  >;
  readonly "runtimenode.rename": MethodDescriptor<
    "runtimenode.rename",
    RuntimeNodeRenameRequest,
    EmptyPayload
  >;
  readonly "runtimenode.remove": MethodDescriptor<
    "runtimenode.remove",
    RuntimeNodeRemoveRequest,
    EmptyPayload
  >;
  readonly "runtimenode.certificateChallengeSet": MethodDescriptor<
    "runtimenode.certificateChallengeSet",
    RuntimeNodeCertificateChallengeSetRequest,
    EmptyPayload
  >;
}

/**
 * The runtime-node procedures the control plane serves, each with its schemas.
 *
 * @consumedBy the control plane's `runtimenode.*` procedures
 */
export const RUNTIMENODE_PROCEDURE_DESCRIPTORS: RuntimeNodeProcedureDescriptors =
  defineMethodDescriptors({
    "runtimenode.register": {
      method: "runtimenode.register",
      procedureType: "mutation",
      mutating: true,
      requestSchema: RuntimeNodeRegisterRequestSchema,
      responseSchema: EmptyPayloadSchema,
    },
    "runtimenode.rename": {
      method: "runtimenode.rename",
      procedureType: "mutation",
      mutating: true,
      requestSchema: RuntimeNodeRenameRequestSchema,
      responseSchema: EmptyPayloadSchema,
    },
    "runtimenode.remove": {
      method: "runtimenode.remove",
      procedureType: "mutation",
      mutating: true,
      requestSchema: RuntimeNodeRemoveRequestSchema,
      responseSchema: EmptyPayloadSchema,
    },
    "runtimenode.certificateChallengeSet": {
      method: "runtimenode.certificateChallengeSet",
      procedureType: "mutation",
      mutating: true,
      requestSchema: RuntimeNodeCertificateChallengeSetRequestSchema,
      responseSchema: EmptyPayloadSchema,
    },
  });
