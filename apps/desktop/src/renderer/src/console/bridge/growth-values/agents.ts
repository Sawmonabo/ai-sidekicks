// The agent-roster plane's values: what one `agent.list` row says about a binding.
//
// `agent.list` is registered in `docs/architecture/contracts/api-payload-contracts.md`
// §`agent.attach / agent.detach / agent.configUpdate / agent.list` and in no code
// package, so it fails the reply registry's second admission conjunct and is the
// growth port's. What is named here is the part of that reply the console renders —
// the EFFECTIVE provider axis and the pending switch — rather than the whole row: a
// value shaped by what a surface reads is a value a reader can check, and a mirror of
// the registered interface would be a second declaration of a shape this console does
// not own.

/**
 * The boundary a pending switch applies at.
 *
 * Closed and declared once, exactly as the registered `AgentProviderSwitchPending`
 * declares it, so the sentence the chip composes maps this vocabulary through a
 * record the compiler holds total rather than interpolating whatever string arrived.
 */
export const GROWTH_AGENT_SWITCH_BOUNDARIES = ["turn_boundary", "run_boundary"] as const;

/** One such boundary. Derived from the enumeration, never restated. */
export type GrowthAgentSwitchBoundary = (typeof GROWTH_AGENT_SWITCH_BOUNDARIES)[number];

/**
 * A switch accepted and not yet applied.
 *
 * Present on the row exactly while one is pending — including after a daemon
 * restart, which re-arms it from the durable agent row — so presence is the wire's
 * own discriminator and the console derives no "is switching" of its own.
 */
export interface GrowthAgentPendingSwitch {
  readonly switchId: string;
  readonly appliesAt: GrowthAgentSwitchBoundary;
  /**
   * Whether reaching that boundary requires an interrupt the daemon must dispatch.
   *
   * Independent of the boundary — a deferred switch and an interrupted one can both
   * read `turn_boundary` — so it is carried rather than re-derived.
   */
  readonly interruptRequested: boolean;
}

/**
 * One agent as the roster read reports it.
 *
 * `providerAccountId` absent is STATED and never defaulted: it means the provider's
 * registered default account is paying, which is a different fact from an account
 * whose label has not been read.
 */
export interface GrowthAgentSummary {
  readonly agentId: string;
  readonly providerAccountId: string | undefined;
  readonly pendingSwitch: GrowthAgentPendingSwitch | undefined;
}
