// The agent console as a whole window: its own heading, and the body under it.
//
// `Spec-023 §Console Design (Meridian)` §The surface set names two panes that "can be
// moved into their own hardened `BrowserWindow`", and this is the second one's window
// mount. A window OWNS ITS FRAME and shares no store with the deck it was torn from
// (I-023-12), so the deck's pane chrome is deliberately absent here rather than
// rendered without its controls: a window does not detach from itself, it is not one
// pane among several to be closed or dragged, and a breadcrumb trail describing a
// position in a deck would describe a deck this surface is not in.
//
// SO THE HEADING IS THIS MODULE'S, AND IT IS THE ONLY ONE. The body below draws no
// head at all — the deck names it by the chrome's trail and this window names it here
// — and the two names are one heading per mount rather than a heading inside a trail.
//
// AND THE SUBJECT LINE IS HERE FOR THE SAME REASON. In the deck the agent this
// console is about is a crumb of the chrome's own trail, so a sentence repeating it
// one element away would be the duplication the shared chrome exists to end. This
// window has no trail, so the one place it can say which agent it holds — or that it
// was opened on a session and given no agent — is under its heading.

import { useId } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { WireFigure } from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import { AgentConsoleBody } from "./AgentConsoleBody.js";

export interface AgentConsoleWindowProps {
  /** The session this window is scoped to, wire-verbatim. */
  readonly sessionId: string | undefined;
  /** The agent it is about, wire-verbatim, or `undefined` where none was named. */
  readonly agentId: string | undefined;
  /** Absent where the mount could not resolve one; the body's columns say so. */
  readonly bridge?: ConsoleBridge | undefined;
  /** Absent on a bare route, which the surface context admits. */
  readonly sessionStore?: SessionStore | undefined;
}

/**
 * The window's frame: a named region, its heading, its subject, and the body.
 *
 * NAMED BY ITS OWN HEADING RATHER THAN BY AN `aria-label` BESIDE IT. The two cannot
 * both name one element — the accessible-name algorithm prefers the reference, so a
 * label beside it is text nothing ever reads — and pointing at the heading is what
 * keeps the name a person hears identical to the one they see. `useId` mints the
 * reference because a second window loading this same bundle would collide on any
 * literal.
 */
export function AgentConsoleWindow(props: AgentConsoleWindowProps): React.JSX.Element {
  const headingId = useId();

  return (
    <section className="meridian-agent-console-window" aria-labelledby={headingId}>
      <header className="meridian-agent-console-window__head">
        <h2 id={headingId} className="meridian-agent-console-window__title">
          Agent console
        </h2>
        {props.agentId === undefined ? (
          <p className="meridian-agent-console-window__subject">
            This console is open on a session and not yet on one of its agents.
          </p>
        ) : (
          <p className="meridian-agent-console-window__subject">
            <WireFigure value={props.agentId} />
          </p>
        )}
      </header>

      <AgentConsoleBody
        sessionId={props.sessionId}
        agentId={props.agentId}
        bridge={props.bridge}
        sessionStore={props.sessionStore}
      />
    </section>
  );
}
