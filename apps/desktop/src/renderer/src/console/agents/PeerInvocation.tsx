// Letting one sidekick reach another — only after a person says so, never invisibly.
//
// THREE STATES, NOT TWO. The control renders the PROJECTED `peerInvocationEnabled`
// member on the session read, and that member being ABSENT is its own state: the
// responder predates it. Defaulting an unknown capability grant to "off" would
// present an enabled session as safe, which is the one wrong answer here, so absence
// renders as unknown with a re-read and never as a switch in its off position.
//
// THE TWO TOOLS ARE NAMED REGARDLESS OF THE STATE. Both are registered at spawn
// unconditionally and every invocation is adjudicated per call, reading the projected
// flag as policy context — so a disabled session answers each call `denied` and a
// withdrawal binds the NEXT call with no respawn. Filtering them out of the list by
// enablement would describe a registry composed differently from the one that exists,
// and would leave the operator who just enabled the capability watching nothing
// happen.
//
// WHAT IT IS NOT. Not a remembered approval rule and not an approval category: this
// is a named operation action and mints neither. And an invoke refusal is not an
// error code here — it arrives on the callback-tool result's denied or failed arm and
// lands as an ordinary tool-activity row in the timeline.

import type { ConsoleRefusal } from "../core/index.js";
import { Chip, Nothing, RefusalCard, WireFigure } from "../primitives/index.js";
import { PEER_INVOCATION_TOOLS } from "./agent-wire.js";

export interface PeerInvocationProps {
  /**
   * The projected member. `undefined` is the third state — the member is absent from
   * the reply — and is never rendered as `false`.
   */
  readonly enabled: boolean | undefined;
  readonly onSetEnabled: (enabled: boolean) => void;
  /** Re-reads the session projection. Offered only in the unknown state. */
  readonly onReRead: () => void;
  readonly refusal?: ConsoleRefusal | undefined;
}

export function PeerInvocation(props: PeerInvocationProps): React.JSX.Element {
  return (
    <section className="meridian-peer" aria-label="Peer invocation">
      <h4 className="meridian-peer__title">Sidekicks reaching each other</h4>

      {props.enabled === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This session did not report whether peer invocation is on."
          detail="The member is absent from the reply, which is not the same as off — a session that has it enabled would look identical here."
          action={
            <button type="button" className="meridian-peer__action" onClick={props.onReRead}>
              Read it again
            </button>
          }
        />
      ) : (
        <>
          <label className="meridian-peer__switch">
            <input
              type="checkbox"
              checked={props.enabled}
              onChange={(event) => props.onSetEnabled(event.target.checked)}
            />
            <span className="meridian-peer__switch-label">
              {props.enabled ? "On for this session" : "Off — the default in every new session"}
            </span>
          </label>
          <p className="meridian-peer__meaning">
            {props.enabled
              ? "Sidekicks may invoke each other for the remainder of this session, with no per-call prompt."
              : "Turning this on grants automatic peer invocation for the remainder of the session, with no per-call prompt. Turning it off again takes effect on the very next invocation on every live leg, with no respawn."}
          </p>
        </>
      )}

      <ul className="meridian-peer__tools">
        {PEER_INVOCATION_TOOLS.map((tool) => (
          <li key={tool.toolName} className="meridian-peer__tool">
            <WireFigure value={tool.toolName} />
            <Chip tone="neutral" mono label={tool.linkType} />
          </li>
        ))}
      </ul>
      <p className="meridian-peer__visibility">
        Every invocation appears as an ordinary tool-activity row with a timeline-visible run behind
        it. There is no invisible peer invocation.
      </p>

      {props.refusal === undefined ? null : <RefusalCard {...props.refusal} />}
    </section>
  );
}
