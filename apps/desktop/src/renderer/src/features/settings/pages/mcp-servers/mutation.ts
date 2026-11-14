// The governance mutations this page sends, how each settles, and the idempotency key it
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
  McpRegistrySearchRequest,
  McpRegistrySearchResponse,
  McpServerBindingRef,
  McpServerDeleteRequest,
  McpServerDeleteResponse,
  McpServerEnabledUpdateRequest,
  McpServerLegStatus,
  McpServerMutationResponse,
  McpServerReconnectRequest,
  McpServerReconnectResponse,
  McpServerSignInRequest,
  McpServerSignInResponse,
  McpServerUpsertRequest,
  McpToolOverrideClearRequest,
  McpToolOverrideMutationResponse,
  McpToolOverrideUpdateRequest,
} from "@ai-sidekicks/contracts/mcp/server";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { DaemonReply } from "#renderer/services/daemon/reply.js";

/**
 * What a settled change answered: each grade it took effect at, in the order the service named
 * them and each once, and each live session it touched, absent where it touched none.
 */
export interface McpChangeSettlement {
  readonly grades: readonly McpApplicationGrade[];
  readonly liveResults: readonly McpLiveApplicationResult[] | undefined;
}

/**
 * How a mutation this page sent has settled. `serverSent` is an added or changed server the
 * service took; `signInPageOpened` is a sign-in whose page the system browser was handed;
 * `reconnected` is a reconnect the service answered, `isUnchanged` where no session's reading
 * moved; `refused` is a send that rejected, carrying the service's own words.
 */
export type McpMutationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "settled" | "serverSent";
      readonly binding: McpServerBindingRef;
      readonly settlement: McpChangeSettlement;
    }
  | { readonly kind: "signInPageOpened"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "reconnected";
      readonly binding: McpServerBindingRef;
      readonly isUnchanged: boolean;
    }
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

/** A binding whose switch applies in one project at a time: a connector's or an organization's. */
export type McpProjectScopedBindingRef = Extract<
  McpServerBindingRef,
  { readonly scope: "connector" | "managed" }
>;

/** The code a sign-in reads under when the system browser would not open its page. */
export const SIGN_IN_PAGE_UNOPENED_CODE = "mcp-sign-in-page-unopened";

/**
 * What a sign-in that did not finish reads: one the service could not start, or whose page the
 * system browser would not open.
 */
export const SIGN_IN_UNFINISHED_WORDS = "Sign-in did not finish.";

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

/** Adds a server, or changes the declaration of one at the same place and name. */
export type SendMcpUpsert = (request: McpServerUpsertRequest) => Promise<McpServerMutationResponse>;

/** Removes a binding from its provider's config. */
export type SendMcpDelete = (request: McpServerDeleteRequest) => Promise<McpServerDeleteResponse>;

/** Asks the provider to open a binding's connection again, answering each session's reading. */
export type SendMcpReconnect = (
  request: McpServerReconnectRequest,
) => Promise<McpServerReconnectResponse>;

/**
 * Searches the public MCP Registry through the service, answering its page or the refusal in its
 * place; `signal` ends the search's hold on its answer once a newer search replaces it.
 */
export type SearchMcpRegistry = (
  request: McpRegistrySearchRequest,
  signal: AbortSignal,
) => Promise<DaemonReply<McpRegistrySearchResponse>>;

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

/**
 * How a binding-level change or a removal settled: its one grade and each live session it
 * touched.
 */
export function settlementOfMutation(
  result: McpServerMutationResponse | McpServerDeleteResponse,
): McpChangeSettlement {
  return { grades: [result.applied], liveResults: result.liveResults };
}

/**
 * Whether a reconnect moved no session's reading: each session the service answered for reads as
 * it did before the press, and no session joined or left.
 */
export function isReconnectUnchanged(
  legsBefore: readonly McpServerLegStatus[],
  legsAfter: readonly McpServerLegStatus[],
): boolean {
  return (
    legsBefore.length === legsAfter.length &&
    legsAfter.every((after) =>
      legsBefore.some(
        (before) =>
          before.sessionId === after.sessionId &&
          before.bindingId === after.bindingId &&
          before.status === after.status,
      ),
    )
  );
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
