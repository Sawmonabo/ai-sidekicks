// The nodes page: which machines a session's agents can run on, and what each one
// is allowed to do.
//
// `Spec-023 §Console Design (Meridian)` §Runtime nodes: "Show every runtime node
// attached to a session and let its owner manage its own attachment … Both health
// axes side by side, never collapsed into one scalar, because they have different
// owners and a recovery on one must never mask a degradation on the other."
//
// THE ROSTER IS ABSORBED, NOT REWRITTEN
//
// That section says so in terms: "Absorb the four shipped views under
// `runtime-node-attach/` … wholesale and with every tripwire intact: no collapsed
// health scalar, no filter that hides a node, no loading flash on re-read, and the
// out-of-order read guard." The absorbed mount is `seats/absorbed-surfaces.ts`'s —
// it hands the view the roster read and the presence subscription this page's own
// bridge serves — and this page composes it rather than reaching for the
// component, exactly as the agent console does. Restyling is Meridian tokens over
// the same structure, so this file adds chrome and no second projection of
// `state`, `healthState`, or `readOnly`.
//
// WHAT THE ROSTER RENDERS NOWHERE, AND WHERE IT LANDS
//
// That view renders five of the roster entry's nine members and neither the capability
// map a node declares about itself nor the client version a floor verdict is computed
// from. Both are Plan-003's own shipped views — `CapabilityDeclaration` and
// `MixedVersionStatus`, absorbed by import beside the roster — and this page mounts
// them in its own block from the SAME read: `seats/node-roster-seam.ts` records each
// response as it passes through the console's own read seam on its way to that view,
// so what a node declares and how it is doing are one answer rather than two that can
// disagree.
//
// THE RE-READ IS RAISED, NEVER FORCED. The absorbed view holds its rows against the
// seam it read through and seeds a new seam at `loading`, so handing it a fresh one to
// refresh would return a live roster to its loading shape — the flash its own tripwire
// forbids. What this page raises instead is the presence signal its contract already
// takes, on window focus, and the view re-reads through its own path.
//
// AND WHO HOLDS THE SHARED SHELL, WHICH IS NOT A COLUMN. `controlHolder` rides the
// roster RESPONSE rather than a row, because one write lease exists per session — so
// it renders as one line beside the node list, out of the same recorded read, and the
// page offers no lease control: taking and releasing belong to the terminal deck,
// against the daemon that owns the lease record.
//
// WHAT THIS PAGE OFFERS, AND WHAT DECIDES WHETHER IT CAN
//
// The section names three controls: the roster read, an attach, and a capability
// snapshot refresh. The roster is session-scoped and the settings address carries no
// session, so the page asks for the session the console has open and renders the
// absence when there is none. The attach control mounts the shipped flow through
// `seats/absorbed-surfaces.ts`, which resolves the attach draft rather than accepting
// one: that draft is a machine's claim about its own identity, contract version,
// health and capability set, and `Spec-023 §Trust Stance` puts its composition in the
// main process, off the node registry. So the page names the control and the SEAT
// decides whether there is a declaration to review — a scenario's under the fixture,
// nothing under the live bridge until a registered read delivers one — and the absence
// it renders is a statement about this window rather than about attaching.

import type { ReactNode } from "react";

import { renderAbsorbedAttachFlow, renderAbsorbedNodeRoster } from "../../../seats/index.js";
import { ControlHolderBlock } from "./ControlHolderBlock.js";
import { NodeDeclarationsBlock } from "./NodeDeclarationsBlock.js";
import { Chip, Nothing } from "../../../primitives/index.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-nodes";

export function RuntimeNodesPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, retainedSessionId, retainedSessionStore } = props.context;
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        A runtime node is a machine that can run this session&rsquo;s agents. Every node keeps two
        independent health readings — the attachment&rsquo;s own state and the heartbeat
        sweep&rsquo;s presence verdict — and the console renders both, because a recovery on one
        must never hide a degradation on the other.
      </p>

      <div className="meridian-settings-page__chips">
        <Chip tone="neutral" label="Attachment state" glyph="dot" />
        <Chip tone="neutral" label="Heartbeat presence" glyph="clock" />
        <Chip tone="attention" label="Below the version floor stays visible" glyph="alert" />
      </div>

      <section
        className="meridian-settings-page__block meridian-node-roster"
        aria-label="Attached runtime nodes"
      >
        <h3 className="meridian-settings-page__block-title">Attached nodes</h3>
        {retainedSessionId === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="The node roster belongs to a session, and this window has opened none."
            detail="Open a session from the Sessions list and its nodes render here. Nothing was asked of the control plane for a session nobody has opened."
          />
        ) : (
          renderAbsorbedNodeRoster(bridge, retainedSessionId)
        )}
      </section>

      {retainedSessionId === undefined ? null : (
        <ControlHolderBlock
          bridge={bridge}
          sessionId={retainedSessionId}
          sessionStore={retainedSessionStore}
        />
      )}

      {retainedSessionId === undefined ? null : (
        <NodeDeclarationsBlock bridge={bridge} sessionId={retainedSessionId} />
      )}

      <section
        className="meridian-settings-page__block meridian-node-attach"
        aria-label="Managing an attachment"
      >
        <h3 className="meridian-settings-page__block-title">Attaching a node</h3>
        <p className="meridian-settings-page__aside">
          An attach is one deliberate act, and the declaration it carries is reviewed before it is
          sent — never fired because something rendered. Refreshing a capability snapshot carries
          the same declaration and is the node&rsquo;s own act for the same reason.
        </p>
        {renderAbsorbedAttachFlow(bridge, retainedSessionId)}
      </section>
    </div>
  );
}

/**
 * Claim the nodes section.
 *
 * A page registers ITSELF: the descriptor's id, its search vocabulary, and its body
 * live in the module that owns the page, and the family door calls one function per
 * page at its own reserved line. A table in the door would be one file every page
 * lane edits, which is the conflict the console's seat boards exist to avoid.
 */
export function registerRuntimeNodesPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "nodes",
    owner: OWNER,
    label: "Runtime nodes",
    keywords: [
      "machines",
      "attach",
      "detach",
      "heartbeat",
      "health",
      "capabilities",
      "version floor",
      "read-only",
      "terminal control",
      "shared shell",
      "lease",
    ],
    render: (context) => <RuntimeNodesPage context={context} />,
  });
}
