// Where a driver hands a provider's permission ask once the run engine admitted it, so the
// approval pipeline asks the person and answers through `ProviderDriver.respondToRequest`.
import type { RememberedRuleSense, RememberedScopeKind } from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * What the held call would do, read by the driver from its provider's own ask: run a command,
 * send input to the running command the ask's tool call names, change files, read one file or
 * folder, reach a host, leave plan mode with the plan it proposed, or call a tool none of those
 * covers.
 */
export type ProviderAskAction =
  | { readonly kind: "plan" }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "command_input"; readonly input: string }
  | { readonly kind: "file_change"; readonly paths: readonly string[] }
  | { readonly kind: "file_read"; readonly path: string }
  | { readonly kind: "network"; readonly host: string }
  | { readonly kind: "tool"; readonly toolName: string };

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
  /** What the call would do, which the card shows and a rule names. */
  action: ProviderAskAction;
  /**
   * The scopes a standing rule on this ask may take, none where the provider keeps no rule for it
   * (a running command's input) and no `project` where it has no project rule file for its kind.
   */
  ruleScopes: readonly RememberedScopeKind[];
  /** The held tool call's id (Claude Code's `tool_use_id`, Codex's `itemId`), where it sent one. */
  toolCallId?: string | undefined;
  prompt?: string | undefined;
}

/** An ask the provider withdrew before anyone answered it, by the request id it was taken under. */
interface ProviderPermissionAskWithdrawal {
  sessionId: SessionId;
  requestId: string;
}

/**
 * A standing rule the provider keeps: an allow made on an approval or a host's block made on a
 * network decline, for the session or in the project's own rule file. `subject` is the words the
 * card named, of the kind of action the ask was: a command's program and first subcommand, a
 * file's path, a host, or a tool's name.
 */
export interface ProviderAskRule {
  readonly kind: RememberedScopeKind;
  readonly sense: RememberedRuleSense;
  readonly action: ProviderAskAction["kind"];
  readonly subject: string;
}

/**
 * The approval pipeline's answer to one permission ask, which each driver turns into its
 * provider's own: an allow, with the command or path as the person corrected it, or a refusal,
 * with the decline's typed reason. Either may carry the rule its answer made.
 */
export type ProviderPermissionAnswer =
  | {
      readonly decision: "allow";
      readonly editedAction?: string | undefined;
      readonly rule?: ProviderAskRule | undefined;
    }
  | {
      readonly decision: "refuse";
      readonly reason?: string | undefined;
      readonly rule?: ProviderAskRule | undefined;
    };

/**
 * The approval pipeline's intake of admitted asks, registered through a `PortRegistration`. Each
 * call resolves once it is recorded and rejects when it could not be; the answer comes later,
 * through `respondToRequest` with a {@link ProviderPermissionAnswer}. A withdrawn ask settles its
 * card canceled. Until it is registered, an admitted ask stays pending at the provider: nothing
 * answers it.
 */
export interface PermissionAskPort {
  takeAsk(ask: ProviderPermissionAsk): Promise<void>;
  withdrawAsk(withdrawal: ProviderPermissionAskWithdrawal): Promise<void>;
}
