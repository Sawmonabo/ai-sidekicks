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
// out-of-order read guard." The absorbed mount is `frame/legacy-surfaces.ts`'s —
// it hands the view the roster read and the presence subscription this page's own
// bridge serves — and this page composes it rather than reaching for the
// component, exactly as the agent console does. Restyling is Meridian tokens over
// the same structure, so this file adds chrome and no second projection of
// `state`, `healthState`, or `readOnly`.
//
// WHAT THIS PAGE CANNOT OFFER, AND WHY IT SAYS SO
//
// The section names three controls: the roster read, an attach, and a capability
// snapshot refresh. The roster is session-scoped and the settings address carries
// no session, so the page asks for the session the console has open and renders the
// absence when there is none. The attach and refresh controls take an attach draft
// — a node identity plus its declared capability map — that no address and no
// registered read supplies to this renderer; `frame/legacy-surfaces.ts` states the
// same fact about the same component. Composing one here would be inventing the
// declaration a node makes about itself, so the page renders the absence and names
// what is missing instead.

import type { ReactNode } from "react";

import { renderAbsorbedNodeRoster } from "../../../seats/index.js";
import { Chip, Nothing } from "../../../primitives/index.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-nodes";

export function RuntimeNodesPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, retainedSessionId } = props.context;
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

      <section className="meridian-settings-page__block" aria-label="Attached runtime nodes">
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

      <section className="meridian-settings-page__block" aria-label="Managing an attachment">
        <h3 className="meridian-settings-page__block-title">Attaching a node</h3>
        <Nothing
          kind="not-checked"
          placement="inline"
          title="This console composes no attachment for you."
          detail="Attaching a node and refreshing its declared capabilities both carry a declaration the node makes about itself, and no read this window performs supplies one. The node’s own runtime attaches it; nothing was asked here."
        />
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
    ],
    render: (context) => <RuntimeNodesPage context={context} />,
  });
}
