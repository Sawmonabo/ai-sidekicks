// What a scripted `agent.list` reply becomes, and the one place it is narrowed.
//
// The fixture answers this operation from a scenario's script, and a script carries
// `unknown`: `agent.list` is registered in
// `docs/architecture/contracts/api-payload-contracts.md` §`agent.attach /
// agent.detach / agent.configUpdate / agent.list` and in no code package, so there is
// no schema for `assertScriptedReplyOnContract` to hold it to and nothing would
// typecheck a row a scenario made up. The narrowing is therefore the console's own,
// exactly as `approvals/approval-records.ts` is for the two approvals reads — and for
// the same reason: a scenario must not be able to teach a surface a row shape the
// wire will not send.
//
// TWO FACTS ARE READ AND THE REST OF THE ROW IS LEFT ALONE. `growth-values/agents.ts`
// declares what the console renders — the EFFECTIVE `providerAccountId` and the
// pending switch — and the shipped scenarios carry `name`, `driverName`, `modelId`,
// `config`, `state`, and `createdAt` besides. Those are the agents-table projection's,
// which has no surface on this branch, so the row schema admits them and reads
// neither: a narrowing that rejected unknown members would make this fixture refuse
// the scenarios the repo already ships, and one that CARRIED them would publish
// members no component reads.
//
// AN ABSENT `providerAccountId` IS THE ANSWER AND NEVER A GAP. It says the provider's
// registered default account is paying, which the chip states in those words. That is
// why the member is optional here and required-with-`undefined` on the summary: the
// wire may omit it, and the console's own value type may not, or a reader could
// forget the case exists.
//
// A REPLY THIS CANNOT READ THROWS, and the rejection is left to travel. It is a
// scenario authoring error of the class `assertScriptedReplyOnContract` raises on the
// call arm, the caller renders it as a refusal, and that is what a live transport's
// own rejection would reach the same caller as. Returning an empty roster instead
// would report "this session has no such agent" for a script nobody could read.

import { z } from "zod";

import {
  GROWTH_AGENT_SWITCH_BOUNDARIES,
  type GrowthAgentSummary,
} from "../growth-values/agents.js";

/**
 * The pending switch as the row carries it.
 *
 * `appliesAt` is held to the declared vocabulary rather than admitted as a string:
 * the chip maps that value through a record the compiler holds total, so a boundary
 * name outside the enumeration would reach a surface with no sentence for it.
 */
const pendingSwitchSchema = z.object({
  switchId: z.string(),
  appliesAt: z.enum(GROWTH_AGENT_SWITCH_BOUNDARIES),
  interruptRequested: z.boolean(),
});

/**
 * One roster row, admitting the members this console does not read.
 *
 * Not `.strict()`, deliberately: see the header. `agentId` is the row's identity and
 * is required — a roster row nothing can be matched against is not a row.
 */
const agentRowSchema = z.object({
  agentId: z.string(),
  providerAccountId: z.string().optional(),
  pendingSwitch: pendingSwitchSchema.optional(),
});

const agentListSchema = z.object({ agents: z.array(agentRowSchema) });

/**
 * Narrow an `agent.list` reply into the roster the target chip reads.
 *
 * The summaries are BUILT rather than passed through, so the value carries exactly
 * the three members `GrowthAgentSummary` declares — present on every row, absent
 * where the wire said nothing — instead of whichever of them the parse happened to
 * populate.
 */
export function readAgentRoster(reply: unknown): readonly GrowthAgentSummary[] {
  return agentListSchema.parse(reply).agents.map((row) => ({
    agentId: row.agentId,
    providerAccountId: row.providerAccountId,
    pendingSwitch: row.pendingSwitch,
  }));
}
