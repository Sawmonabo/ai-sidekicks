// Which hosts this session's log still says are reachable.
//
// A second pure fold beside the lease one, and it exists because the lease's
// degraded state is a fact about a HOST while the lease events carry none.
// `Spec-023 §Console Design (Meridian)` 8.8: "when the holding node reads offline,
// `controlHolder` resolves to null and the surface renders unheld". Nothing on
// `pty.control_changed` names a node, so without this fold the pane could only ever
// pass `not-checked` and the degraded rendering was unreachable from the wire.
//
// WHY THE LOG AND NOT THE ROSTER READ. `runtimenode.roster` is where the wire
// ultimately answers this — the read suppresses `controlHolder` to null while the
// producing node's presence reads offline, writing nothing and authoring no event —
// but the member carrying that answer is not on the shipped `.strict()` response
// schema in the contracts package, so reading it would be consuming a member the
// contract does not carry. The `runtime_node.*` lifecycle events ARE registered
// types with registered payload shapes, and the store already holds them in the
// timeline. That is the only carrier this console has, so it is the one used.
//
// THE REJECTED ALTERNATIVE, WRITTEN DOWN SO THE NEXT READER DOES NOT RE-DERIVE IT.
// A lifecycle payload carries an `actor`, and matching it against the lease holder
// looks like a link from a holder to the machine it sits on. It is not one: `actor`
// is who the log attributes the event to — the person who attached the node, or
// nobody at all where the daemon acted alone — and reading it as the node's owning
// participant would be inventing a member's meaning. The wire gives no
// holder-to-node link at all. So {@link resolveSoleHoldingNode} answers only in the
// case where there is nothing to link: one attached node, one shared shell, no
// ambiguity about which host runs it. Zero nodes and two or more are both `undefined`
// — not-checked, which is the honest answer to a question this console cannot ask.
//
// TOTAL AND PURE, on `lease-model.ts`'s discipline: given the same events, the same
// answer, so a replayed prefix reads the same as a live stream and a reconnect heals
// by re-running it. No class, because there is no state to hold between calls.

import { NodeStateSchema, type SessionEventType } from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../store/index.js";
import type { TerminalHoldingNodeReading } from "./lease-model.js";

/**
 * The event kinds whose registered payload reports a NODE STATE.
 *
 * WHY A KIND AND NOT THE MEMBER. This fold used to key on the `runtime_node.`
 * prefix plus the presence of a `newState` member, on the reasoning that what moves
 * a node's reachability is the state an event reports rather than its name. The
 * contract refutes it: `runtime_node.capability_updated` carries `previousState`
 * and `newState` too, and they are `CapabilityDetails` SNAPSHOTS rather than
 * `NodeState` values (`packages/contracts/src/runtime-node.ts`, the reduced
 * capability base and the note beside it). The member is spelled the same and means
 * something else — so a capability health change parsed as a node state, failed,
 * and overwrote a perfectly good `online` reading with `unknown` until the next
 * lifecycle event arrived.
 *
 * THE THREE BELOW ARE THE CONTRACT'S OWN. `packages/contracts/src/event.ts`
 * registers five `runtime_node.*` payload variants; three compose the FULL
 * lifecycle base (`{sessionId?, nodeId, previousState?, newState: NodeState,
 * actor?}`) and are the ones listed here, and two compose the REDUCED capability
 * base, which declares no node state at all. Each key is written as a
 * `SessionEventType`, so a kind this console invents — or one a later release
 * renames — is a compile error rather than an arm that silently matches nothing.
 *
 * `runtime_node.degraded` and `runtime_node.revoked` are deliberately absent. They
 * are census members with NO registered payload variant (server-derived, V1.1-gated
 * on the node-identity trust anchor), so there is no registered shape to read a
 * state off — and reading a member off an unregistered payload is the exact mistake
 * this list exists to undo. When their variants register, they join this list and
 * the compiler is what admits them.
 */
const PRESENCE_TRANSITION_EVENT_KINDS = [
  "runtime_node.registered",
  "runtime_node.online",
  "runtime_node.offline",
] as const satisfies readonly SessionEventType[];

/**
 * What the newest presence event says about a host.
 *
 * `unknown` is not a synonym for `unreachable`: it is the reading for a node whose
 * newest state this build cannot place, and it keeps the surface at `not-checked`
 * instead of collapsing a lease on a state nobody understood.
 */
export const TERMINAL_NODE_REACHABILITIES = ["reachable", "unreachable", "unknown"] as const;

export type TerminalNodeReachability = (typeof TERMINAL_NODE_REACHABILITIES)[number];

/** One node the log has mentioned, and the newest thing it said about it. */
export interface TerminalNodePresenceEntry {
  readonly nodeId: string;
  readonly reachability: TerminalNodeReachability;
}

/**
 * Fold a session's events into per-node reachability, newest write winning.
 *
 * Total and pure. Every kind outside {@link PRESENCE_TRANSITION_EVENT_KINDS} is
 * skipped — both capability kinds included, so a capability health change leaves
 * the host's presence reading exactly as the newest lifecycle event left it — and
 * so is a presence event whose payload names no node or carries no state member at
 * all: the first has nothing to key on and the second is not a payload the daemon
 * could have emitted, since the registered shape requires the member.
 *
 * A present state the registered vocabulary does not admit is a different fact and
 * takes a different answer: it is the newest thing the log said about this host,
 * this build cannot place it, and `unknown` is the reading that says so. Skipping it
 * would leave the last state this build DID understand standing as current, which is
 * how a host reads reachable after the wire said something newer.
 *
 * Order is first-mention, so the entries read the way the log introduced the hosts.
 */
export function projectNodePresence(
  events: readonly ConsoleSessionEvent[],
): readonly TerminalNodePresenceEntry[] {
  const reachabilityByNodeId = new Map<string, TerminalNodeReachability>();

  for (const event of events) {
    if (!isPresenceTransitionKind(event.kind)) {
      continue;
    }
    const payload = event.payload;
    if (payload === undefined) {
      continue;
    }
    const nodeId = payload["nodeId"];
    if (typeof nodeId !== "string" || nodeId === "") {
      continue;
    }
    if (!Object.hasOwn(payload, "newState")) {
      continue;
    }
    reachabilityByNodeId.set(nodeId, readReachability(payload["newState"]));
  }

  return [...reachabilityByNodeId].map(([nodeId, reachability]) => ({ nodeId, reachability }));
}

/**
 * Whether one event kind is one this fold reads a node state from.
 *
 * A comparison over the tuple rather than a `Set` built at module load, on
 * `lease-transition.ts`'s `asTerminalLeaseTransitionReason` shape: the set has three
 * members, the module holds no state between calls, and a module-level `Set` is the
 * singleton `apps/desktop/AGENTS.md` rejects.
 */
function isPresenceTransitionKind(kind: string): boolean {
  return PRESENCE_TRANSITION_EVENT_KINDS.some((presenceKind) => presenceKind === kind);
}

/**
 * The one node a lease holder must be sitting on, when the log knows exactly one.
 *
 * `undefined` — which the lease fold reads as `not-checked` — for every other case:
 * zero nodes, two or more, and the single node whose newest state this build could
 * not place. See this module's header for why one is the only answerable case and
 * why the payload's `actor` is not a substitute for the link the wire withholds.
 */
export function resolveSoleHoldingNode(
  nodes: readonly TerminalNodePresenceEntry[],
): TerminalHoldingNodeReading | undefined {
  const [sole, ...rest] = nodes;
  if (sole === undefined || rest.length > 0 || sole.reachability === "unknown") {
    return undefined;
  }
  return { nodeId: sole.nodeId, isReachable: sole.reachability === "reachable" };
}

/**
 * What one reported node state means for reachability.
 *
 * Read through the contract's own guard rather than against a second copy of the
 * vocabulary, so the set is declared once; the switch below is exhaustive over it,
 * so a sixth state is a compile error rather than a silent `unknown`.
 *
 * The mapping follows the read-side rule the degraded state exists for: the roster
 * suppresses the holder while the producing node's presence reads OFFLINE, so a
 * `degraded` node — still reporting, just impaired — is one the control plane can
 * still vouch for. `revoked` takes the fail-closed direction rather than the honest
 * middle: a revoked attachment is not serving this session's shell under any
 * reading, and the cost of being wrong is a read-only surface rather than a keyboard
 * offered into a machine that is gone. `registering` is genuinely unknown — presence
 * has not been established yet, so neither answer has been read.
 */
function readReachability(candidate: unknown): TerminalNodeReachability {
  const nodeState = NodeStateSchema.safeParse(candidate);
  if (!nodeState.success) {
    return "unknown";
  }
  switch (nodeState.data) {
    case "online":
    case "degraded":
      return "reachable";
    case "offline":
    case "revoked":
      return "unreachable";
    case "registering":
      return "unknown";
  }
}
