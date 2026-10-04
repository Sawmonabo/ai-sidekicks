// The daemon's callback tools as the allowlist picker reads them. The catalog is node-wide
// (the editor has no session) and static: names come from the daemon's own registrations,
// never from provider output.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { DRIVER_TOOL_DESCRIPTION_MAX_LEN, DRIVER_TOOL_NAME_MAX_LEN } from "./provider-driver.js";
import { wireFreeFormString } from "./session.js";

/** `callbackTool.list` takes no members. */
export type CallbackToolListRequest = Record<string, never>;
/** Parses a {@link CallbackToolListRequest}: an empty object. */
export const CallbackToolListRequestSchema: z.ZodType<
  CallbackToolListRequest,
  CallbackToolListRequest
> = z.object({}).strict();

/**
 * One callback tool. `name` is the name a provider sees; `label` is the words a
 * person reads, the one label the picker and the transcript both draw, and a tool
 * without one is drawn as its name in sentence case.
 */
export interface CallbackToolEntry {
  name: string;
  label?: string | undefined;
  description: string;
}

/** The daemon's callback tools. */
export interface CallbackToolListResponse {
  tools: CallbackToolEntry[];
}
/** Parses a {@link CallbackToolListResponse}. */
export const CallbackToolListResponseSchema: z.ZodType<CallbackToolListResponse> = z
  .object({
    tools: z.array(
      z
        .object({
          name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "CallbackToolEntry.name"),
          label: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "CallbackToolEntry.label").optional(),
          description: z.string().max(DRIVER_TOOL_DESCRIPTION_MAX_LEN),
        })
        .strict(),
    ),
  })
  .strict();

/** The `callbackTool.*` methods. */
export interface CallbackToolMethodDescriptors {
  readonly "callbackTool.list": MethodDescriptor<
    "callbackTool.list",
    CallbackToolListRequest,
    CallbackToolListResponse
  >;
}

/**
 * The `callbackTool.*` method table.
 *
 * @consumedBy the daemon's `callbackTool.list` handler
 */
export const CALLBACK_TOOL_METHOD_DESCRIPTORS: CallbackToolMethodDescriptors =
  defineMethodDescriptors({
    "callbackTool.list": {
      method: "callbackTool.list",
      procedureType: "query",
      mutating: false,
      requestSchema: CallbackToolListRequestSchema,
      responseSchema: CallbackToolListResponseSchema,
    },
  });
