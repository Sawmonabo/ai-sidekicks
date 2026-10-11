// Where a driver reads the standing rules in force on a session, so what it hands its provider
// (Claude Code's flag settings, Codex's held calls) carries every rule the person made and none
// they took back.
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderAskAction, ProviderAskRule } from "./permission-ask.js";

/**
 * The approval pipeline's read of the rules in force on a session, its own and its project's,
 * registered through a `PortRegistration`; until it is, a session holds none. A revoked rule is one
 * the session made and the person revoked since, which a provider that cannot drop a rule itself
 * must hold the next call on.
 */
export interface SessionRulePort {
  readSessionRules(sessionId: SessionId): readonly ProviderAskRule[];
  /** The revoked rule over `action`'s subject that no rule in force covers again, if any. */
  findRevokedRule(sessionId: SessionId, action: ProviderAskAction): ProviderAskRule | undefined;
}
