// Where a driver hands a provider's permission ask once the run engine admitted it, so the
// approval pipeline asks the person and answers through `ProviderDriver.respondToRequest`.
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * One ask a provider holds a tool call on: the tool, its input as the provider sent it, the
 * provider's own request id the answer goes back under, and its prompt where it sent one.
 */
export interface ProviderPermissionAsk {
  sessionId: SessionId;
  runId: RunId;
  requestId: string;
  toolName: string;
  input: unknown;
  prompt?: string | undefined;
  /**
   * The answers the provider offers for this ask, verbatim and in its order, where it names them
   * (Codex's `availableDecisions`); the card offers these and no others. Absent where the provider
   * names none.
   */
  providerDecisions?: readonly unknown[] | undefined;
}

/** An ask the provider withdrew before anyone answered it, by the request id it was taken under. */
interface ProviderPermissionAskWithdrawal {
  sessionId: SessionId;
  requestId: string;
}

/**
 * The approval pipeline's intake of admitted asks, registered through a `PortRegistration`. Each
 * call resolves once it is recorded and rejects when it could not be; the answer comes later. A
 * withdrawn ask settles its card canceled. Until it is registered, an admitted ask stays pending
 * at the provider: nothing answers it.
 */
export interface PermissionAskPort {
  takeAsk(ask: ProviderPermissionAsk): Promise<void>;
  withdrawAsk(withdrawal: ProviderPermissionAskWithdrawal): Promise<void>;
}
