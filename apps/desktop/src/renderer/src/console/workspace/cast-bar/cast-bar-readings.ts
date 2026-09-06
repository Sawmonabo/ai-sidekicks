// The three readings the bar renders, each named for the question it answers.
//
// Beside `cast-bar-reads.ts` rather than inside it, because that module owns HOW a
// read settles and this one owns WHICH reads the bar puts and what it takes from
// each. The split is what keeps the shared projection free of any one wire's shape.
//
// EACH TAKES EXACTLY WHAT IT RENDERS AND NOTHING ELSE. The identity read answers a
// summary and the bar renders all of it; the health read answers a whole projection
// and the bar renders one category and one count; the receipt answers a decomposition
// along three axes and the bar renders the single committed figure. Narrowing here
// rather than in the components keeps the components rendering and keeps every wire
// shape inside one module.

import {
  useConsoleBridge,
  type GrowthPort,
  type GrowthSessionSummary,
} from "../../bridge/index.js";
import { useCastBarRead, type CastBarReadState } from "./cast-bar-reads.js";

/** The node's health, as much of it as a one-line form says. */
export interface CastBarHealthReading {
  /** The wire's own status category, verbatim — never re-worded and never re-derived. */
  readonly overall: string;
  /** How many components are not `healthy`, counted from the wire's own readings. */
  readonly unwellComponentCount: number;
  /** The component names behind that count, in the order the wire listed them. */
  readonly unwellComponentNames: readonly string[];
}

/** The one figure `Spec-023 §Rules every console surface obeys` lets a surface show. */
export interface CastBarSpendReading {
  readonly committedSpendCents: number;
  /** Whether the wire itself calls the figure fully priced. Observability only. */
  readonly costStatus: string;
}

/** The bridge's growth port, for a surface that reads three of its operations. */
export function useCastBarGrowthPort(): GrowthPort {
  return useConsoleBridge().growth;
}

/** One session's display title and its wire-verbatim state. */
export function useCastBarIdentity(
  growth: GrowthPort,
  sessionId: string | undefined,
): CastBarReadState<GrowthSessionSummary> {
  return useCastBarRead(growth, sessionId, async (subject) =>
    growth.sessionIdentityRead({ sessionId: subject }),
  );
}

/**
 * The node's health, folded to what one line can hold.
 *
 * KEYED ON THE SESSION EVEN THOUGH HEALTH IS NODE-WIDE, because the bar is a session
 * surface: a window that moves between sessions re-reads, which is when a person
 * actually looks. The alternative — a key of `undefined` — would hold one answer for
 * the life of the port and never refresh at all.
 *
 * The count and the names are folded HERE rather than in the component, so the
 * component renders and this module is the only place that knows what the wire's
 * component rows look like.
 */
export function useCastBarHealth(
  growth: GrowthPort,
  sessionId: string | undefined,
): CastBarReadState<CastBarHealthReading> {
  return useCastBarRead(growth, sessionId, async () => {
    const outcome = await growth.healthStatusRead({});
    if (outcome.status !== "served") {
      return outcome;
    }
    // "Not healthy" rather than "degraded or blocked": the wire's category set is
    // closed at three today, and a fold written against the two named arms would
    // silently count a fourth as well.
    const unwell = outcome.value.components.filter((component) => component.state !== "healthy");
    return {
      status: "served",
      value: {
        overall: outcome.value.overall,
        unwellComponentCount: unwell.length,
        unwellComponentNames: unwell.map((component) => component.component),
      },
    };
  });
}

/**
 * The session's committed spend, from the one accountant.
 *
 * `orchestrationBudgetRead` and not the receipt beside it. The two are served from
 * the same accountant accessor and cannot disagree, and the receipt's extra value is
 * a decomposition along three axes this bar renders none of — so calling it here
 * would pull a per-run, per-caused-by and per-paying-account breakdown across the
 * bridge on every session open to render one number off the top of it.
 *
 * The figure taken is `committedSpendCents`, which is the enforced one. Nothing is
 * summed and nothing is added to it — the "renderer never sums visible rows" rule
 * applies as much to a total composed from two served figures as to one composed
 * from the screen.
 */
export function useCastBarSpend(
  growth: GrowthPort,
  sessionId: string | undefined,
): CastBarReadState<CastBarSpendReading> {
  return useCastBarRead(growth, sessionId, async (subject) => {
    const outcome = await growth.orchestrationBudgetRead({ sessionId: subject });
    return outcome.status === "served"
      ? {
          status: "served",
          value: {
            committedSpendCents: outcome.value.committedSpendCents,
            costStatus: outcome.value.costStatus,
          },
        }
      : outcome;
  });
}
