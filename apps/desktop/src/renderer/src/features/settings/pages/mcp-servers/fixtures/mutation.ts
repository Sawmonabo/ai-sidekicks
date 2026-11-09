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
  McpApprovalMode,
  McpAssignableIdempotencyClass,
  McpLiveApplicationResult,
  McpServerBindingRef,
  McpServerEnabledUpdateRequest,
  McpServerMutationResponse,
  McpServerSignInRequest,
  McpServerSignInResponse,
  McpToolOverrideClearRequest,
  McpToolOverrideMutationResponse,
  McpToolOverrideUpdateRequest,
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
 * How a mutation this fixture body sent has settled. `signInPageOpened` is a sign-in whose page
 * the system browser was handed; `refused` is a send that rejected, carrying the service's own
 * words.
 */
export type McpMutationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "settled";
      readonly binding: McpServerBindingRef;
      readonly settlement: McpChangeSettlement;
    }
  | { readonly kind: "signInPageOpened"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "refused";
      readonly binding: McpServerBindingRef;
      readonly refusal: Refusal;
    };

/** The outcome a row starts in and returns to. Shared so it has one spelling. */
export const IDLE_MCP_MUTATION: McpMutationOutcome = { kind: "idle" };

/**
 * A binding whose own switch names no project: every scope but a connector's and an
 * organization's, whose switch applies in one project.
 */
export type McpSwitchableBindingRef = Exclude<
  McpServerBindingRef,
  { readonly scope: "connector" | "managed" }
>;

/** The code a sign-in reads under when the system browser would not open its page. */
export const SIGN_IN_PAGE_UNOPENED_CODE = "mcp-sign-in-page-unopened";

/** Mints the key one press carries. Injected so a test can drive a retry. */
export type IdempotencyKeyMinter = () => string;

/** Sends a binding's enablement change to the daemon. */
export type SendMcpEnabled = (
  request: McpServerEnabledUpdateRequest,
) => Promise<McpServerMutationResponse>;

/** Sends one tool's override to the daemon. */
export type SendMcpToolOverride = (
  request: McpToolOverrideUpdateRequest,
) => Promise<McpToolOverrideMutationResponse>;

/** Sends the clear of one facet of a tool's override to the daemon. */
export type SendMcpClearToolOverride = (
  request: McpToolOverrideClearRequest,
) => Promise<McpToolOverrideMutationResponse>;

/** Starts the service's own sign-in for a binding's server, answering its sign-in page. */
export type SendMcpSignIn = (request: McpServerSignInRequest) => Promise<McpServerSignInResponse>;

/**
 * What one press on a tool's facet asks for: a value set here, naming that facet alone, or the
 * facet returned to the server's own value, which clears it alone.
 */
export type McpToolFacetChange =
  | {
      readonly kind: "set";
      readonly override:
        | { readonly enabled: boolean }
        | { readonly approvalMode: McpApprovalMode }
        | { readonly idempotencyClass: McpAssignableIdempotencyClass };
    }
  | { readonly kind: "clear" };

/** The default minter: the platform's own identifier source. */
export function mintIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** How a binding-level change settled: its one grade and each live session it touched. */
export function settlementOfMutation(result: McpServerMutationResponse): McpChangeSettlement {
  return { grades: [result.applied], liveResults: result.liveResults };
}

/**
 * How a tool override set or clear settled: the grade of each facet it touched, each grade once,
 * since two facets taking effect the same way settle with one line.
 */
export function settlementOfToolOverride(
  result: McpToolOverrideMutationResponse,
): McpChangeSettlement {
  const { enabled, approvalMode, idempotencyClass } = result.applied;
  const grades = [enabled, approvalMode, idempotencyClass].filter(
    (grade): grade is McpApplicationGrade => grade !== undefined,
  );
  return { grades: [...new Set(grades)], liveResults: undefined };
}
