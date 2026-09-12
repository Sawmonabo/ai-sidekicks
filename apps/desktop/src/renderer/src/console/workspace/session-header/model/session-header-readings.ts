// The three readings the session header renders, each named for the question it answers.
//
// Beside `session-header-read-projection.ts` rather than inside it, because that module owns HOW a
// read settles and this one owns WHICH reads the bar puts and what it takes from
// each. The split is what keeps the shared projection free of any one wire's shape.
//
// EACH TAKES EXACTLY WHAT IT RENDERS AND NOTHING ELSE. The identity read answers a
// summary and the header renders all of it; the health read answers a whole projection
// and the header takes one count and the names behind it; the receipt answers a
// decomposition along three axes and the header renders the single committed figure.
// Narrowing here rather than in the components keeps the components rendering and
// keeps every wire shape inside one module.

import {
  useConsoleBridge,
  type GrowthPort,
  type GrowthSessionSummary,
  type SettledReadRefusal,
} from "../../../bridge/index.js";
import {
  useSessionHeaderRead,
  type SessionHeaderReadState,
} from "./session-header-read-projection.js";

/**
 * The header's ONE reading of the node's health — the verdict both halves decide from.
 *
 * A verdict rather than the raw read state, because the header answers two questions off
 * this one reading and it used to answer them separately: `SessionHeaderStatus` drew its
 * amber mark from the served count while `SessionHeaderBody` derived an all-clear from the
 * event log alone, so a node with an unwell component and no outstanding ask rendered
 * the mark and "Nothing needs you." in the same strip. One value read by both is what
 * makes that pair unrepresentable rather than merely repaired.
 */
export type SessionHeaderHealthVerdict =
  | { readonly kind: "in-flight" }
  | { readonly kind: "unchecked"; readonly refusal: SettledReadRefusal }
  | { readonly kind: "clear" }
  | ({ readonly kind: "unwell" } & SessionHeaderHealthReading);

/** The one cost figure a surface may show: the accountant's own committed value. */
export interface SessionHeaderSpendReading {
  readonly committedSpendCents: number;
  /** Whether the wire itself calls the figure fully priced. Observability only. */
  readonly costStatus: string;
}

/** The bridge's growth port, for a surface that reads three of its operations. */
export function useSessionHeaderGrowthPort(): GrowthPort {
  return useConsoleBridge().growth;
}

/** One session's display title and its wire-verbatim state. */
export function useSessionHeaderIdentity(
  growth: GrowthPort,
  sessionId: string | undefined,
): SessionHeaderReadState<GrowthSessionSummary> {
  return useSessionHeaderRead(growth, sessionId, async (subject) =>
    growth.sessionIdentityRead({ sessionId: subject }),
  );
}

/**
 * The node's health, folded to what one line can hold and to one verdict.
 *
 * KEYED ON THE SESSION EVEN THOUGH HEALTH IS NODE-WIDE, because the header is a session
 * surface: a window that moves between sessions re-reads, which is when a person
 * actually looks. The alternative — a key of `undefined` — would hold one answer for
 * the life of the port and never refresh at all.
 *
 * The count and the names are folded HERE rather than in the component, so the
 * component renders and this module is the only place that knows what the wire's
 * component rows look like.
 *
 * WHY ONLY `unwell` SUPPRESSES THE ALL-CLEAR, and neither of the two arms that have
 * no answer. The line is a claim about what this strip shows — and an unanswered read
 * shows the "not checked" kind of nothing beside it, which is the header reporting the
 * absence rather than dressing it as health. Suppressing on `in-flight` as well would
 * additionally make the line arrive a few hundred milliseconds after the header drew,
 * which is the same late-badge move `SessionHeaderStatus` refuses one component over.
 */
export function useSessionHeaderHealth(
  growth: GrowthPort,
  sessionId: string | undefined,
): SessionHeaderHealthVerdict {
  const health = useSessionHeaderRead(growth, sessionId, async () => {
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
        unwellComponentCount: unwell.length,
        unwellComponentNames: unwell.map((component) => component.name),
      },
    };
  });
  return sessionHeaderHealthVerdict(health);
}

/**
 * The session's committed spend, from the one accountant.
 *
 * `orchestrationBudgetRead` and not the receipt beside it. The two are served from
 * the same accountant accessor and cannot disagree, and the receipt's extra value is
 * a decomposition along three axes this header renders none of — so calling it here
 * would pull a per-run, per-caused-by and per-paying-account breakdown across the
 * bridge on every session open to render one number off the top of it.
 *
 * The figure taken is `committedSpendCents`, which is the enforced one. Nothing is
 * summed and nothing is added to it — the "renderer never sums visible rows" rule
 * applies as much to a total composed from two served figures as to one composed
 * from the screen.
 */
export function useSessionHeaderSpend(
  growth: GrowthPort,
  sessionId: string | undefined,
): SessionHeaderReadState<SessionHeaderSpendReading> {
  return useSessionHeaderRead(growth, sessionId, async (subject) => {
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

/** What the health read answers with, folded to the two facts one line can hold. */
interface SessionHeaderHealthReading {
  /** How many components are not `healthy`, counted from the wire's own readings. */
  readonly unwellComponentCount: number;
  /** The component names behind that count, in the order the wire listed them. */
  readonly unwellComponentNames: readonly string[];
}

/** The read state as the four things the header does about it, and nothing else. */
function sessionHeaderHealthVerdict(
  health: SessionHeaderReadState<SessionHeaderHealthReading>,
): SessionHeaderHealthVerdict {
  if (health.status === "reading") {
    return { kind: "in-flight" };
  }
  if (health.status === "unavailable") {
    return { kind: "unchecked", refusal: health.refusal };
  }
  return health.value.unwellComponentCount === 0
    ? { kind: "clear" }
    : { kind: "unwell", ...health.value };
}
