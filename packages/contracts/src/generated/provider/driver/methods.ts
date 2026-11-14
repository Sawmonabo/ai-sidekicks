// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The driver methods a client calls (`provider.model.list`, `provider.mode.list`, `provider.command.list`, `agent.run.context.compact`), their requests and replies, grouped by provider.

import type { SchemaCheck } from "../../../schema-check.js";
import type { AgentId } from "../../agent/definition.js";
import { validateProviderCommandListResponse } from "../../checks/provider/driver/commands.js";
import { validateAgentRunContextCompactResponse } from "../../checks/provider/driver/compaction.js";
import {
  validateAgentRunContextCompactRequest,
  validateProviderCommandListRequest,
  validateProviderModeListRequest,
  validateProviderModeListResponse,
  validateProviderModelListRequest,
  validateProviderModelListResponse,
} from "../../checks/provider/driver/methods.js";
import type { RunId } from "../../run/id.js";
import type { SessionId } from "../../session/id.js";
import type { ProviderId } from "../id.js";
import type { ProviderMode, ProviderModel } from "./capabilities.js";
import type { ProviderCommandListResponse } from "./commands.js";
import type { AgentRunContextCompactResponse } from "./compaction.js";

/**
 * The longest short identifier or label: a model's and a mode's id and name, and the words
 * in its capabilities, effort levels and output-speed levels.
 */
export const PROVIDER_WIRE_TOKEN_MAX_LEN = 128 as const;

/**
 * The longest opaque provider handle a client echoes back, roomier than a token, because
 * refusing a real handle would make a valid request unsendable.
 */
export const PROVIDER_WIRE_HANDLE_MAX_LEN = 256 as const;

/** The longest reason the person gives on an interrupt or a cancel. */
export const PROVIDER_WIRE_REASON_MAX_LEN = 512 as const;

/** The longest contract version a driver reports, where the daemon reads and stores it. */
export const PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN = 64 as const;

/** The refusal of a provider operation that outlived its deadline. */
export const PROVIDER_TIMEOUT_CODE = "provider.timeout" as const;

/**
 * One installed provider's outcome in the `provider.model.list` reply: its models, or the failure
 * its catalog's read answered, so one provider's outage never hides another's models.
 */
export type ProviderModelReport =
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Its models.
       */
      models: ProviderModel[];
      /**
       * Only a failed read carries a failure.
       */
      failure?: never;
    }
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Why the read failed.
       */
      failure: ProviderReadFailure;
      /**
       * Only a read catalog carries models.
       */
      models?: never;
    };
/**
 * One installed provider's outcome in the `provider.mode.list` reply: its modes, or the failure
 * their read answered, so one provider's outage never hides another's modes.
 */
export type ProviderModeReport =
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Its modes.
       */
      modes: ProviderMode[];
      /**
       * Only a failed read carries a failure.
       */
      failure?: never;
    }
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Why the read failed.
       */
      failure: ProviderReadFailure;
      /**
       * Only a read list carries modes.
       */
      modes?: never;
    };

/**
 * The request of `provider.model.list`: the session whose model control reads the catalog.
 */
export interface ProviderModelListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The request of `provider.mode.list`: the session whose level control reads the report.
 */
export interface ProviderModeListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * Why one provider's models or modes could not be read: the refusal its read answered with, and
 * the provider's own words where it gave any.
 */
export interface ProviderReadFailure {
  /**
   * The refusal's code, as a JSON-RPC error's `data.type` carries it.
   */
  code: string;
  /**
   * What the provider said, where it said anything.
   */
  providerFailureDetail?: string;
}
/**
 * A provider whose catalog was read: its models.
 */
export interface ProviderModelsListed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Its models.
   */
  models: ProviderModel[];
  /**
   * Only a failed read carries a failure.
   */
  failure?: never;
}
/**
 * A provider whose catalog could not be read: why, never an empty catalog.
 */
export interface ProviderModelsFailed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Why the read failed.
   */
  failure: ProviderReadFailure;
  /**
   * Only a read catalog carries models.
   */
  models?: never;
}
/**
 * The reply of `provider.model.list`: one outcome per installed provider, the session's own
 * provider first, then the provider table's order.
 */
export interface ProviderModelListResponse {
  /**
   * The groups.
   */
  providers: ProviderModelReport[];
}
/**
 * A provider whose modes were read: its modes.
 */
export interface ProviderModesListed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Its modes.
   */
  modes: ProviderMode[];
  /**
   * Only a failed read carries a failure.
   */
  failure?: never;
}
/**
 * A provider whose modes could not be read: why, never an empty list.
 */
export interface ProviderModesFailed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Why the read failed.
   */
  failure: ProviderReadFailure;
  /**
   * Only a read list carries modes.
   */
  modes?: never;
}
/**
 * The reply of `provider.mode.list`: one outcome per installed provider, the session's own
 * provider first, then the provider table's order.
 */
export interface ProviderModeListResponse {
  /**
   * The groups.
   */
  providers: ProviderModeReport[];
}
/**
 * The request of `agent.run.context.compact`, the person's compaction of one run's context. The
 * reply's `refused` and `failed` arms are data a caller branches on, never a refusal.
 */
export interface AgentRunContextCompactRequest {
  /**
   * The session, the scope checked first.
   */
  sessionId: SessionId;
  /**
   * The run within it.
   */
  runId: RunId;
}
/**
 * The request of `provider.command.list`: the commands and skills one agent's providers
 * publish, one group per live binding the agent holds.
 */
export interface ProviderCommandListRequest {
  /**
   * The session, the scope checked first.
   */
  sessionId: SessionId;
  /**
   * The agent within it.
   */
  agentId: AgentId;
}

export {
  validateAgentRunContextCompactRequest,
  validateProviderCommandListRequest,
  validateProviderModeListRequest,
  validateProviderModeListResponse,
  validateProviderModeReport,
  validateProviderModelListRequest,
  validateProviderModelListResponse,
  validateProviderModelReport,
  validateProviderReadFailure,
} from "../../checks/provider/driver/methods.js";

/** The methods of {@link PROVIDER_DRIVER_METHOD_DESCRIPTORS}, each with its checks. */
export interface ProviderDriverMethodDescriptors {
  readonly "provider.model.list": {
    readonly method: "provider.model.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderModelListRequest>;
    readonly responseCheck: SchemaCheck<ProviderModelListResponse>;
  };
  readonly "provider.mode.list": {
    readonly method: "provider.mode.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderModeListRequest>;
    readonly responseCheck: SchemaCheck<ProviderModeListResponse>;
  };
  readonly "agent.run.context.compact": {
    readonly method: "agent.run.context.compact";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentRunContextCompactRequest>;
    readonly responseCheck: SchemaCheck<AgentRunContextCompactResponse>;
  };
  readonly "provider.command.list": {
    readonly method: "provider.command.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderCommandListRequest>;
    readonly responseCheck: SchemaCheck<ProviderCommandListResponse>;
  };
}
/** The driver methods a client calls: their names, how each answers, and their shapes. */
export const PROVIDER_DRIVER_METHOD_DESCRIPTORS: ProviderDriverMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "provider.model.list": /* @__PURE__ */ Object.freeze({
      method: "provider.model.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateProviderModelListRequest,
      responseCheck: validateProviderModelListResponse,
    }),
    "provider.mode.list": /* @__PURE__ */ Object.freeze({
      method: "provider.mode.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateProviderModeListRequest,
      responseCheck: validateProviderModeListResponse,
    }),
    "agent.run.context.compact": /* @__PURE__ */ Object.freeze({
      method: "agent.run.context.compact",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateAgentRunContextCompactRequest,
      responseCheck: validateAgentRunContextCompactResponse,
    }),
    "provider.command.list": /* @__PURE__ */ Object.freeze({
      method: "provider.command.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateProviderCommandListRequest,
      responseCheck: validateProviderCommandListResponse,
    }),
  });
