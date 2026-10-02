// The ports a machine shares with the person's other devices: the shared list, the forward to
// one port, the web address a browser tab opens it at, and the two refusals that guard them.
// The machine forwards only listed ports, and only to its own loopback.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { isoDateTimeSchema, portSchema } from "./internal/wire-scalars.js";

/** A port added to the shared list that is on it already; nothing changes. */
export const PREVIEW_PORT_ALREADY_SHARED_CODE = "preview.port_already_shared" as const;
/** The type of {@link PREVIEW_PORT_ALREADY_SHARED_CODE}. */
export type PreviewPortAlreadySharedCode = typeof PREVIEW_PORT_ALREADY_SHARED_CODE;

/**
 * A forward or a web ticket asked for a port that is not on the shared list. The
 * machine forwards only listed ports, and only to its own loopback.
 */
export const PREVIEW_PORT_NOT_SHARED_CODE = "preview.port_not_shared" as const;
/** The type of {@link PREVIEW_PORT_NOT_SHARED_CODE}. */
export type PreviewPortNotSharedCode = typeof PREVIEW_PORT_NOT_SHARED_CODE;

/** The details both port refusals carry: the port the request named. */
export interface PreviewPortRefusalDetails {
  port: number;
}
/** Parses {@link PreviewPortRefusalDetails}. */
export const PreviewPortRefusalDetailsSchema: z.ZodType<PreviewPortRefusalDetails> = z
  .object({ port: portSchema })
  .strict();

/** The machine's shared ports; the list is the machine's, so the request names nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PreviewPortShareListRequest {}
/** Parses a {@link PreviewPortShareListRequest}. */
export const PreviewPortShareListRequestSchema: z.ZodType<
  PreviewPortShareListRequest,
  PreviewPortShareListRequest
> = z.object({}).strict();

/**
 * One shared port with what the machine knows of it: the framework discovery named,
 * `null` where it named none, and whether anything listens on it yet. A port may be
 * shared before its server starts.
 */
export interface PreviewSharedPort {
  port: number;
  framework: string | null;
  listening: boolean;
  addedAt: string;
}
/** Parses a {@link PreviewSharedPort}. */
export const PreviewSharedPortSchema: z.ZodType<PreviewSharedPort> = z
  .object({
    port: portSchema,
    framework: z.string().min(1).nullable(),
    listening: z.boolean(),
    addedAt: isoDateTimeSchema,
  })
  .strict();

/** One frame of the shared-ports list: every shared port, in the order they were added. */
export interface PreviewPortShareListFrame {
  ports: PreviewSharedPort[];
}
/** Parses a {@link PreviewPortShareListFrame}. */
export const PreviewPortShareListFrameSchema: z.ZodType<PreviewPortShareListFrame> = z
  .object({ ports: z.array(PreviewSharedPortSchema) })
  .strict();

/**
 * Names one port: share it, stop sharing it, open a forward to it, or issue the web
 * address's ticket for it.
 */
export interface PreviewPortRequest {
  port: number;
}
/** Parses a {@link PreviewPortRequest}. */
export const PreviewPortRequestSchema: z.ZodType<PreviewPortRequest, PreviewPortRequest> = z
  .object({ port: portSchema })
  .strict();

/** The port now shared, and when. */
export interface PreviewPortShareAddResponse {
  port: number;
  addedAt: string;
}
/** Parses a {@link PreviewPortShareAddResponse}. */
export const PreviewPortShareAddResponseSchema: z.ZodType<PreviewPortShareAddResponse> = z
  .object({ port: portSchema, addedAt: isoDateTimeSchema })
  .strict();

/**
 * The port is no longer shared and every forward open on it is closed. Removing a
 * port that is not shared answers the same.
 */
export interface PreviewPortShareRemoveResponse {
  port: number;
  removed: true;
}
/** Parses a {@link PreviewPortShareRemoveResponse}. */
export const PreviewPortShareRemoveResponseSchema: z.ZodType<PreviewPortShareRemoveResponse> = z
  .object({ port: portSchema, removed: z.literal(true) })
  .strict();

/**
 * The shared port's own web address for a browser tab, carrying a one-time ticket
 * good for 60 seconds that the machine trades for a cookie scoped to the address.
 */
export interface PreviewPortTicketIssueResponse {
  address: string;
}
/** Parses a {@link PreviewPortTicketIssueResponse}; the address is always `https:`. */
export const PreviewPortTicketIssueResponseSchema: z.ZodType<PreviewPortTicketIssueResponse> = z
  .object({ address: z.url({ protocol: /^https$/u }) })
  .strict();

/** The `preview.port*` methods the daemon answers. */
export interface PreviewPortMethodDescriptors {
  readonly "preview.portShareList": SubscriptionMethodDescriptor<
    "preview.portShareList",
    PreviewPortShareListRequest,
    SubscribeAckResponse,
    PreviewPortShareListFrame
  >;
  readonly "preview.portShareAdd": MethodDescriptor<
    "preview.portShareAdd",
    PreviewPortRequest,
    PreviewPortShareAddResponse
  >;
  readonly "preview.portShareRemove": MethodDescriptor<
    "preview.portShareRemove",
    PreviewPortRequest,
    PreviewPortShareRemoveResponse
  >;
  readonly "preview.portTicketIssue": MethodDescriptor<
    "preview.portTicketIssue",
    PreviewPortRequest,
    PreviewPortTicketIssueResponse
  >;
}

/** The `preview.port*` methods the daemon answers, each with its schemas. */
export const PREVIEW_PORT_METHOD_DESCRIPTORS: PreviewPortMethodDescriptors =
  defineMethodDescriptors({
    "preview.portShareList": {
      method: "preview.portShareList",
      procedureType: "subscription",
      mutating: false,
      requestSchema: PreviewPortShareListRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: PreviewPortShareListFrameSchema,
    },
    "preview.portShareAdd": {
      method: "preview.portShareAdd",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPortRequestSchema,
      responseSchema: PreviewPortShareAddResponseSchema,
    },
    "preview.portShareRemove": {
      method: "preview.portShareRemove",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPortRequestSchema,
      responseSchema: PreviewPortShareRemoveResponseSchema,
    },
    "preview.portTicketIssue": {
      method: "preview.portTicketIssue",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPortRequestSchema,
      responseSchema: PreviewPortTicketIssueResponseSchema,
    },
  });
