/**
 * Answers a routed Codex server request: a callback tool call goes to the host, an approval ask
 * to the approval responder. Also shapes the reply content Codex receives.
 */

import type { CallbackToolHost } from "../../../callback-tool-host.js";
import { isPlainObject } from "../../../record-readers.js";
import { normalizeProviderFailureDetail } from "./session/errors.js";
import {
  CallbackToolInvocationSchema,
  type CallbackToolInvocation,
} from "../../provider-driver.js";
import type {
  CodexServerRequestDecision,
  CodexSessionServerRequest,
  CodexSessionServerRequestResponder,
} from "./server-requests.js";

/** Construction inputs for {@link createCallbackToolAskResponder}. */
export interface CallbackToolAskResponderOptions {
  readonly host: CallbackToolHost;
  /**
   * The responder for `askKind: "approval"` asks, or an explicit `null` for a daemon composed
   * without one. Required-but-nullable so every construction site decides.
   */
  readonly approvalAskResponder: CodexSessionServerRequestResponder | null;
}

/**
 * Composes the responder the Codex driver binds for routed asks: callback tool calls go to the
 * {@link CallbackToolHost}, approval asks to the approval responder. Every path answers; a refusal
 * becomes the asking method's own refusal shape, not a protocol fault.
 */
export function createCallbackToolAskResponder(
  options: CallbackToolAskResponderOptions,
): CodexSessionServerRequestResponder {
  const { host, approvalAskResponder } = options;
  return {
    async answer(request: CodexSessionServerRequest): Promise<CodexServerRequestDecision> {
      if (request.askKind === "approval") {
        if (approvalAskResponder === null) {
          // No diagnostic: the `callback_tool_*` kinds name this host's own conditions, so one here
          // would misattribute the refusal. The reason still reaches the provider.
          return {
            decision: "refuse",
            reason:
              `The daemon has no approval responder registered for "${request.method}"; ` +
              `refusing rather than answering without adjudication.`,
          };
        }
        return await approvalAskResponder.answer(request);
      }

      const invocation = readCallbackToolInvocation(request);
      if (typeof invocation === "string") {
        host.recordUnformedInvocation({
          sessionId: request.sessionId,
          runId: request.runId,
          toolName: readOptionalWireString(request.params, "tool"),
          toolCallId: readOptionalWireString(request.params, "callId"),
          detail: invocation,
        });
        return { decision: "refuse", reason: invocation };
      }

      // Unscoped (`null`) is safe only by provenance: the provider band attributes a routed ask to
      // a live run by turn, so a superseded spawn's calls are refused before this arm. A band
      // without turn-keyed attribution must put a per-spawn token on the ask.
      const result = await host.dispatch(invocation, null);
      if (result.status !== "completed") {
        return {
          decision: "refuse",
          reason:
            result.error ?? "The daemon refused this callback tool call with no stated reason.",
        };
      }
      return {
        decision: "allow",
        payload: { contentItems: composeCallbackToolContentItems(result.output) },
      };
    },
  };
}

/**
 * Builds the `CallbackToolInvocation` one routed ask carries, or returns a `string` refusal reason
 * for the provider and the diagnostic. Field names are the pinned `DynamicToolCallParams`
 * (`tool`, `callId`, `arguments`); a non-object `arguments` is refused.
 */
function readCallbackToolInvocation(
  request: CodexSessionServerRequest,
): CallbackToolInvocation | string {
  // A well-formed call raised outside any active turn cannot be attributed; `runId` is required so
  // no invocation is adjudicated against an invented run.
  if (request.runId === null) {
    return (
      `The provider raised "${request.method}" with no turn active on the session, so the call ` +
      `cannot be attributed to a run; refusing rather than adjudicating it against an invented ` +
      `one.`
    );
  }
  const params = isPlainObject(request.params) ? request.params : {};
  const parsedInvocation = CallbackToolInvocationSchema.safeParse({
    toolName: params["tool"],
    arguments: params["arguments"],
    toolCallId: params["callId"],
    sessionId: request.sessionId,
    runId: request.runId,
  });
  if (!parsedInvocation.success) {
    return (
      `The provider's "${request.method}" params did not parse as a callback-tool invocation; ` +
      `refusing rather than dispatching a malformed call.`
    );
  }
  return parsedInvocation.data;
}

/** One string member of untrusted wire params, or `null`, for a diagnostic's detail field. */
function readOptionalWireString(params: unknown, memberName: string): string | null {
  const value = isPlainObject(params) ? params[memberName] : undefined;
  return typeof value === "string" ? value : null;
}

/**
 * The three content-item arms the pinned `DynamicToolCallOutputContentItem` union declares,
 * each with the one member it requires. Keying by arm checks the union, not just the discriminator.
 */
const CALLBACK_TOOL_CONTENT_ITEM_REQUIRED_MEMBERS: ReadonlyMap<string, string> = new Map([
  ["inputText", "text"],
  ["inputImage", "imageUrl"],
  ["inputAudio", "audioUrl"],
]);

/**
 * Renders a completed tool's `output` as the content-item array the provider requires. A
 * well-formed array is rebuilt from only each item's discriminator and required `string` member, so
 * it is serializable by construction; an absent output is an empty result, and anything else,
 * including one malformed item, becomes a single `inputText` item (dropping or mixing would lose or
 * reorder part of the answer).
 */
export function composeCallbackToolContentItems(output: unknown): unknown[] {
  if (output === undefined) {
    return [];
  }
  if (Array.isArray(output)) {
    const rebuilt = rebuildContentItems(output);
    if (rebuilt !== null) {
      return rebuilt;
    }
  }
  return [{ type: "inputText", text: renderContentItemText(output) }];
}

/** Every candidate rebuilt from its own arm, or `null` if any is not a value the union holds. */
function rebuildContentItems(candidates: readonly unknown[]): unknown[] | null {
  const rebuilt: unknown[] = [];
  for (const candidate of candidates) {
    const item = rebuildContentItem(candidate);
    if (item === null) {
      return null;
    }
    rebuilt.push(item);
  }
  return rebuilt;
}

/** One admitted item reduced to its two declared members, or `null`. */
function rebuildContentItem(candidate: unknown): Record<string, string> | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const item = candidate as Record<string, unknown>;
  const itemType = item["type"];
  if (typeof itemType !== "string") {
    return null;
  }
  const requiredMemberName = CALLBACK_TOOL_CONTENT_ITEM_REQUIRED_MEMBERS.get(itemType);
  if (requiredMemberName === undefined) {
    return null;
  }
  // Non-empty: an empty string is as invisible to the model as a missing member.
  const requiredMember = item[requiredMemberName];
  if (typeof requiredMember !== "string" || requiredMember.length === 0) {
    return null;
  }
  // Only the two declared members, both proven `string`, which makes the result serializable.
  return { type: itemType, [requiredMemberName]: requiredMember };
}

const UNRENDERABLE_OUTPUT_TEXT =
  "The callback tool completed with an output this daemon could not render as text.";

/**
 * Renders one non-content-item output as text. An unserializable value (a cycle, a `BigInt`) still
 * yields a visible item that names why: the call was already allowed and must not become an
 * unanswered frame.
 */
function renderContentItemText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output);
  } catch (cause) {
    return `${UNRENDERABLE_OUTPUT_TEXT} (${normalizeProviderFailureDetail(cause)})`;
  }
  return serialized ?? UNRENDERABLE_OUTPUT_TEXT;
}
