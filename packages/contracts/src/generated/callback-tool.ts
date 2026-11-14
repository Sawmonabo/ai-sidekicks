// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The daemon's callback tools as the allowlist picker reads them.

import type { EmptyPayload } from "./method-descriptor.js";

/**
 * One callback tool. `name` is the name a provider sees; `label` is the words a person reads, the
 * one label the picker and the transcript both draw, and a tool without one is drawn as its name
 * in sentence case.
 */
export interface CallbackToolEntry {
  /**
   * The name a provider sees.
   */
  name: string;
  /**
   * The words a person reads.
   */
  label?: string;
  /**
   * What the tool does.
   */
  description: string;
}
/**
 * The daemon's callback tools.
 */
export interface AgentCallbackToolListResponse {
  /**
   * The tools.
   */
  tools: CallbackToolEntry[];
}

/** The methods of {@link CALLBACK_TOOL_METHOD_DESCRIPTORS}, each with its kind. */
export interface CallbackToolMethodDescriptors {
  readonly "agent.callbackTool.list": {
    readonly method: "agent.callbackTool.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link CALLBACK_TOOL_METHOD_DESCRIPTORS}. */
export interface CallbackToolMethodTypes {
  readonly "agent.callbackTool.list": {
    readonly params: EmptyPayload;
    readonly result: AgentCallbackToolListResponse;
  };
}
/** The `agent.callbackTool.*` methods. */
export const CALLBACK_TOOL_METHOD_DESCRIPTORS: CallbackToolMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "agent.callbackTool.list": /* @__PURE__ */ Object.freeze({
      method: "agent.callbackTool.list",
      procedureType: "query",
      mutating: false,
    }),
  });
