// The governance mutations this fixture body sends, how each settles, and the idempotency key it
// mints.
//
// The key is minted once per press by the view: `clientIdempotencyKey` means "this is the same
// operation", which only the view that watched the press can know, so a key minted inside the
// port would make each retry a new operation. It is carried unchanged through every attempt of
// one press. It is injected, with `crypto.randomUUID()` as the default, so a test can assert a
// retry reused a key. Nothing here decides whether a control may be pressed: every control is
// offered.

import type {
  McpApplicationGrade,
  McpLiveApplicationResult,
  McpMutationResult,
  McpServerBindingRef,
  McpSetEnabledRequest,
  McpSetToolOverrideRequest,
  McpToolOverrideMutationResult,
} from "@ai-sidekicks/contracts/mcp/server";
import type { Refusal } from "#renderer/lib/refusal/contract.js";

/**
 * What a settled change answered: each grade it took effect at, in the order the service named
 * them and each once, and each live session it touched, absent where it touched none.
 */
export interface McpChangeSettlement {
  readonly grades: readonly McpApplicationGrade[];
  readonly liveResults: readonly McpLiveApplicationResult[] | undefined;
}

/**
 * How a mutation this fixture body sent has settled. `refused` is a send that rejected,
 * carrying the service's own words.
 */
export type McpMutationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "settled";
      readonly binding: McpServerBindingRef;
      readonly settlement: McpChangeSettlement;
    }
  | {
      readonly kind: "refused";
      readonly binding: McpServerBindingRef;
      readonly refusal: Refusal;
    };

/** The outcome a row starts in and returns to. Shared so it has one spelling. */
export const IDLE_MCP_MUTATION: McpMutationOutcome = { kind: "idle" };

/** Mints the key one press carries. Injected so a test can drive a retry. */
export type IdempotencyKeyMinter = () => string;

/** Sends a binding's enablement change to the daemon. */
export type SendMcpEnabled = (request: McpSetEnabledRequest) => Promise<McpMutationResult>;

/** Sends one tool's override to the daemon. */
export type SendMcpToolOverride = (
  request: McpSetToolOverrideRequest,
) => Promise<McpToolOverrideMutationResult>;

/** The default minter: the platform's own identifier source. */
export function mintIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** How a binding-level change settled: its one grade and each live session it touched. */
export function settlementOfMutation(result: McpMutationResult): McpChangeSettlement {
  return { grades: [result.applied], liveResults: result.liveResults };
}

/**
 * How a tool override settled: the grade of each facet it touched, each grade once, since two
 * facets taking effect the same way settle with one line.
 */
export function settlementOfToolOverride(
  result: McpToolOverrideMutationResult,
): McpChangeSettlement {
  const { enabled, approvalMode, idempotencyClass } = result.applied;
  const grades = [enabled, approvalMode, idempotencyClass].filter(
    (grade): grade is McpApplicationGrade => grade !== undefined,
  );
  return { grades: [...new Set(grades)], liveResults: undefined };
}
