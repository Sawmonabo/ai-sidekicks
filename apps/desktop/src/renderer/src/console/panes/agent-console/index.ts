// The agent-console pane's door.
//
// One body, two mounts, and the stylesheet both of them render through.
//
// WHY ONE FILE CLAIMS BOTH A PANE KIND AND A SURFACE SLOT
//
// They are two tables answering two questions — the deck's pane registry is keyed
// by pane kind, the frame's surface registry by route destination — and the agent
// console is in both because `Spec-023 §Console Design (Meridian)` §The surface set
// makes it one of exactly two panes that may be torn off into a window of its own.
// The tear-off is the same body at a different size, so a second component would be
// two renderings of one design drifting apart the first time either was edited.
//
// This family REPLACES the shipped node roster's claim on the `agent-console` slot.
// The roster is not discarded: it is absorbed into the pane's machines column,
// which is where it always belonged — it answers "which machines can this session's
// agents run on", and that is a column of an agent console rather than a window.

import "./agent-console.css";

import { createElement } from "react";

import type { ConsoleSurfaceRegistry } from "../../frame/surface-registry.js";
import { routeSessionId } from "../../routing/index.js";
import type { ConsolePaneRegistry } from "../../seats/index.js";
import { AgentConsolePane } from "./AgentConsolePane.js";

/**
 * Claim the `agent-console` pane kind.
 *
 * Whether the kind may be torn off is `isDetachablePaneKind`'s single answer,
 * derived from the window model — this registration makes no claim about it. It is
 * one of the two kinds the spec's surface set admits into an auxiliary window, and
 * the surface registration below is what that window mounts.
 */
export function registerAgentConsolePane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "agent-console",
    owner: "collaboration-agent-console",
    render: (context) =>
      createElement(AgentConsolePane, {
        sessionId: context.sessionStore?.sessionId,
        // The context is the whole address union, so it is narrowed on the kind this
        // descriptor claims before its entity is read: `entity` is not a member of
        // every arm, and the arms that have one carry a reference to something an
        // agent console is not a view of. The registry dispatches by kind, so no
        // other arm reaches this body — and a context that somehow arrived at the
        // wrong door settles as the pane's own "no agent named" reading, which the
        // body already draws, rather than as a throw inside a render.
        agentId: context.kind === "agent-console" ? context.entity?.id : undefined,
        bridge: context.bridge,
        sessionStore: context.sessionStore,
      }),
  });
}

/** Claim the `agent-console` surface slot — the same body, in its own window. */
export function registerAgentConsoleSurface(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "agent-console",
    owner: "collaboration-agent-console",
    render: (context) =>
      createElement(AgentConsolePane, {
        sessionId: routeSessionId(context.route),
        agentId:
          context.route.kind === "auxiliary" && "agentId" in context.route
            ? context.route.agentId
            : undefined,
        bridge: context.bridge,
        sessionStore: context.sessionStore,
      }),
  });
}
