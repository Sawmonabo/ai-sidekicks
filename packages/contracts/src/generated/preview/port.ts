// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The ports a machine shares with the person's other devices, and the `preview.port*` methods.

import type { SchemaCheck } from "../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import {
  validatePreviewPortRequest,
  validatePreviewPortShareAddResponse,
  validatePreviewPortShareListFrame,
  validatePreviewPortShareRemoveResponse,
  validatePreviewPortTicketIssueResponse,
} from "../checks/preview/port.js";
import type { Port, WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";

/** A port added to the shared list that is on it already; nothing changes. */
export const PREVIEW_PORT_SHARE_ALREADY_EXISTS_CODE = "preview.portShare.alreadyExists" as const;

/** A forward or a web ticket asked for a port that is not on the shared list. */
export const PREVIEW_PORT_NOT_SHARED_CODE = "preview.port.notShared" as const;

/**
 * The details both port refusals carry: the port the request named.
 */
export interface PreviewPortRefusalDetails {
  /**
   * The port.
   */
  port: Port;
}
/**
 * One shared port with what the machine knows of it: the framework discovery named, `null` where
 * it named none, and whether anything listens on it yet. A port may be shared before its server
 * starts.
 */
export interface PreviewSharedPort {
  /**
   * The port.
   */
  port: Port;
  /**
   * The framework discovery named.
   */
  framework: string | null;
  /**
   * Whether anything listens on it.
   */
  listening: boolean;
  /**
   * When it was shared.
   */
  addedAt: WireInstant;
}
/**
 * One frame of the shared-ports list: every shared port, in the order they were added. The stream
 * sends the newest list once the reader has room, never a queue of the lists between.
 */
export interface PreviewPortShareListFrame {
  /**
   * The shared ports.
   */
  ports: PreviewSharedPort[];
}
/**
 * Names one port: share it, stop sharing it, or issue the web address's ticket for it.
 */
export interface PreviewPortRequest {
  /**
   * The port.
   */
  port: Port;
}
/**
 * The port now shared, and when.
 */
export interface PreviewPortShareAddResponse {
  /**
   * The port.
   */
  port: Port;
  /**
   * When it was shared.
   */
  addedAt: WireInstant;
}
/**
 * The port is no longer shared and every forward open on it is closed. Removing a port that is
 * not shared answers the same.
 */
export interface PreviewPortShareRemoveResponse {
  /**
   * The port.
   */
  port: Port;
  /**
   * Always `true`.
   */
  removed: true;
}
/**
 * The shared port's own web address for a browser tab, carrying a one-time ticket good for 60
 * seconds that the machine trades for a cookie scoped to the address.
 */
export interface PreviewPortTicketIssueResponse {
  /**
   * The address, always `https:`.
   */
  address: string;
}

export {
  validatePreviewPortRefusalDetails,
  validatePreviewPortRequest,
  validatePreviewPortShareAddResponse,
  validatePreviewPortShareListFrame,
  validatePreviewPortShareRemoveResponse,
  validatePreviewPortTicketIssueResponse,
  validatePreviewSharedPort,
} from "../checks/preview/port.js";

/** The methods of {@link PREVIEW_PORT_METHOD_DESCRIPTORS}, each with its checks. */
export interface PreviewPortMethodDescriptors {
  readonly "preview.portShare.subscribe": {
    readonly method: "preview.portShare.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<PreviewPortShareListFrame>;
  };
  readonly "preview.portShare.add": {
    readonly method: "preview.portShare.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPortRequest>;
    readonly responseCheck: SchemaCheck<PreviewPortShareAddResponse>;
  };
  readonly "preview.portShare.remove": {
    readonly method: "preview.portShare.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPortRequest>;
    readonly responseCheck: SchemaCheck<PreviewPortShareRemoveResponse>;
  };
  readonly "preview.portTicket.issue": {
    readonly method: "preview.portTicket.issue";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPortRequest>;
    readonly responseCheck: SchemaCheck<PreviewPortTicketIssueResponse>;
  };
}
/** The `preview.port*` methods the daemon answers. */
export const PREVIEW_PORT_METHOD_DESCRIPTORS: PreviewPortMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "preview.portShare.subscribe": /* @__PURE__ */ Object.freeze({
      method: "preview.portShare.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validatePreviewPortShareListFrame,
    }),
    "preview.portShare.add": /* @__PURE__ */ Object.freeze({
      method: "preview.portShare.add",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPortRequest,
      responseCheck: validatePreviewPortShareAddResponse,
    }),
    "preview.portShare.remove": /* @__PURE__ */ Object.freeze({
      method: "preview.portShare.remove",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPortRequest,
      responseCheck: validatePreviewPortShareRemoveResponse,
    }),
    "preview.portTicket.issue": /* @__PURE__ */ Object.freeze({
      method: "preview.portTicket.issue",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validatePreviewPortRequest,
      responseCheck: validatePreviewPortTicketIssueResponse,
    }),
  });
