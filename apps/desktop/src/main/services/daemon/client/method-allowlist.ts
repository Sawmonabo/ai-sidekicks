// The daemon methods the desktop calls and opens, and the check every request takes before the
// addon sees it: a method off these tables, or called as the other kind, is refused as
// `request.methodNotAllowed`, and params that fail the method's generated check as
// `request.paramsInvalid`, each in the wire's error shape a daemon refusal takes. The addon checks
// the params against the method's whole contract again as the last line.

import { ARTIFACT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/artifacts/methods";
import { DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import { DAEMON_STATUS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/status";
import { GIT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/git/methods";
import { HIGHLIGHT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/highlight";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { Issue } from "@ai-sidekicks/contracts/jsonrpc/issue";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";
import { MACHINE_SETTINGS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/machine/settings";
import { MCP_EVENT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/mcp/event";
import { MCP_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/mcp/governance";
import { PRESENCE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/presence";
import { PROVIDER_ACCOUNT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/account/methods";
import { PROVIDER_DRIVER_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/driver/methods";
import { QUESTION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/question";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";
import { RUN_CONTROL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/run/control";
import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";
import { SESSION_DRAFT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/draft";
import { SESSION_INSPECTOR_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/inspector";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";
import {
  TERMINAL_CONTROL_METHOD_DESCRIPTORS,
  TERMINAL_METHOD_DESCRIPTORS,
} from "@ai-sidekicks/contracts/terminal";
import { TRANSCRIPT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/transcript/methods";
import { WORKFLOW_DEFINITION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/definition/methods";
import { WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/control";
import { WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/records";
import { WORKFLOW_STEP_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/step/methods";
import { WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/subscription";

import { issuePathOf } from "#shared/daemon/fault-path.js";

/** What the allowlist reads of a method's generated descriptor. */
interface AllowedMethod {
  readonly procedureType: "query" | "mutation" | "subscription";
  readonly requestCheck: SchemaCheck<unknown>;
}

/** Every method the desktop calls or opens, by name, from the generated tables it binds. */
const ALLOWED_METHODS: Readonly<Record<string, AllowedMethod>> = Object.freeze({
  ...ARTIFACT_METHOD_DESCRIPTORS,
  ...DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS,
  ...DAEMON_LIFECYCLE_METHOD_DESCRIPTORS,
  ...DAEMON_STATUS_METHOD_DESCRIPTORS,
  ...GIT_METHOD_DESCRIPTORS,
  ...HIGHLIGHT_METHOD_DESCRIPTORS,
  ...MACHINE_SETTINGS_METHOD_DESCRIPTORS,
  ...MCP_EVENT_METHOD_DESCRIPTORS,
  ...MCP_METHOD_DESCRIPTORS,
  ...PRESENCE_METHOD_DESCRIPTORS,
  ...PROVIDER_ACCOUNT_METHOD_DESCRIPTORS,
  ...PROVIDER_DRIVER_METHOD_DESCRIPTORS,
  ...QUESTION_METHOD_DESCRIPTORS,
  ...REPO_METHOD_DESCRIPTORS,
  ...RUN_CONTROL_METHOD_DESCRIPTORS,
  ...SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  ...SESSION_DRAFT_METHOD_DESCRIPTORS,
  ...SESSION_INSPECTOR_METHOD_DESCRIPTORS,
  ...SESSION_METHOD_DESCRIPTORS,
  ...TERMINAL_CONTROL_METHOD_DESCRIPTORS,
  ...TERMINAL_METHOD_DESCRIPTORS,
  ...TRANSCRIPT_METHOD_DESCRIPTORS,
  ...WORKFLOW_DEFINITION_METHOD_DESCRIPTORS,
  ...WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS,
  ...WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS,
  ...WORKFLOW_STEP_METHOD_DESCRIPTORS,
  ...WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS,
});

/**
 * Why a request for `method` may not go to the addon, in the wire's error shape, or `undefined`
 * when it may: a method off the allowlist or made as the other kind (`isSubscription` says which
 * the asker makes), or params, read with their byte `attachments`, that fail the method's check.
 */
export function requestRefusal(
  method: string,
  params: unknown,
  attachments: readonly Uint8Array[],
  isSubscription: boolean,
): JsonRpcError | undefined {
  if (!Object.hasOwn(ALLOWED_METHODS, method)) {
    return refusal(
      JsonRpcErrorCode.DomainRefusal,
      "request.methodNotAllowed",
      `The app does not call ${method}`,
    );
  }
  const allowed = ALLOWED_METHODS[method]!;
  if ((allowed.procedureType === "subscription") !== isSubscription) {
    return refusal(
      JsonRpcErrorCode.DomainRefusal,
      "request.methodNotAllowed",
      `${method} is not called this way`,
    );
  }
  const check = allowed.requestCheck;
  if (check.call({ attachments }, params)) {
    return undefined;
  }
  const issues = (check.errors ?? []).map((fault) => ({
    path: issuePathOf(fault.instancePath, params),
    message: `breaks the schema's "${fault.keyword}" rule`,
  }));
  return paramsRefusal(method, issues);
}

/** `request.paramsInvalid` for `method`'s params, naming each fault's place and rule. */
export function paramsRefusal(method: string, issues: readonly Issue[]): JsonRpcError {
  return refusal(
    JsonRpcErrorCode.InvalidParams,
    "request.paramsInvalid",
    `The params of ${method} break its contract`,
    { issues },
  );
}

/**
 * A refusal in the wire's error shape. Both codes this module raises the daemon files under
 * `invalidArgument`, which the generated contracts carry only as a type.
 */
function refusal(
  code: number,
  type: Extract<RefusalCode, "request.methodNotAllowed" | "request.paramsInvalid">,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): JsonRpcError {
  return {
    code,
    message,
    data:
      fields === undefined
        ? { type, category: "invalidArgument" }
        : { type, category: "invalidArgument", fields: { ...fields } },
  };
}
