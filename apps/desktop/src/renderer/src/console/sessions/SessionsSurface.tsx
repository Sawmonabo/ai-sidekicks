// The all-sessions list: what am I in the middle of.
//
// `Spec-023 §Console Design (Meridian)` §The all-sessions list: "Answer 'what am I
// in the middle of' in one screen, ordered so the thing you touched last is where
// you left it."
//
// WHAT THIS SURFACE MAY AND MAY NOT CLAIM
//
// There is no session-enumeration verb on any transport — the item sits on the
// growth slate beside the rename, archive, close, and reactivate verbs, which are
// likewise unregistered. So the list is composed from the sessions THIS CONSOLE
// ALREADY HOLDS REFERENCES TO, and its empty state says exactly that rather than
// implying it swept the daemon and found nothing. That distinction is the whole
// difference between "you have no sessions" and "this console has not asked", and
// the five kinds of nothing exist so the console never conflates them.
//
// For the same reason no lifecycle control is drawn: an offered control with no
// wire behind it is the capability-claimed-but-not-implemented shape the design
// forbids, and drawing it disabled is the same claim with a tooltip.
//
// WHAT IS DEFERRED, AND WHY IT IS NOT STUBBED HERE
//
// The two pin tiers, their divider, the status-and-activity comparator, and the row
// context menu are the row lane's. This surface is the frame they land in: with no
// rows to order there is no tier to draw, and drawing an empty tier heading would
// be furniture standing in for a decision nobody has made yet.
//
// THE CREATE AND JOIN CONTROLS ARE THE SHIPPED PROBE, ABSORBED
//
// `session.create` and `session.join` are live now, and one shipped Tier-1 component
// already calls them. Re-authoring those two calls beside it would be a second
// implementation of one job. So the aside mounts that component through the frame's
// absorption helper, which is also what keeps the fixture honest: the component
// reads the installed bridge directly, so under the fixture the frame says the
// question was not put rather than answering from the live daemon in a window
// showing fixture data.

import { DerivedFigure, formatCount, Nothing } from "../primitives/index.js";
import { renderAbsorbedSessionProbe } from "../frame/legacy-surfaces.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";

export interface SessionsSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

/**
 * The sessions this console holds references to.
 *
 * `undefined` while no session store has been opened at all, which is the ordinary
 * state of the sessions address: the route names no session, so the frame opens no
 * store, so there is nothing to read. That is not a read in flight and not an
 * error — it is the honest zero of a console with no enumeration verb, and the
 * empty state below says so in those terms.
 */
function heldSessionCount(context: ConsoleSurfaceContext): number {
  const { sessionStore } = context;
  if (sessionStore === undefined) {
    return 0;
  }
  return Object.keys(sessionStore.snapshot().partitions.session).length;
}

export function SessionsSurface(props: SessionsSurfaceProps): React.JSX.Element {
  const { context } = props;
  const heldCount = heldSessionCount(context);

  return (
    <section className="meridian-sessions" aria-label="Sessions">
      <header className="meridian-sessions__head">
        <h1 className="meridian-sessions__title">Sessions</h1>
        <p className="meridian-sessions__lede">
          The work this console is holding open. It lists the sessions it has references to — there
          is no verb for enumerating the rest, so this is not a sweep of the daemon.
        </p>
      </header>

      <div className="meridian-sessions__body">
        <div className="meridian-sessions__list" aria-label="Open sessions">
          {heldCount === 0 ? (
            <Nothing
              kind="empty"
              placement="surface"
              title="This console is not holding any sessions."
              detail="Start one, or join one you were invited to, and it appears here with its state and whatever is waiting on you."
            />
          ) : (
            <p className="meridian-sessions__count">
              <DerivedFigure
                text={
                  heldCount === 1
                    ? "One session is open in this console."
                    : `${formatCount(heldCount)} sessions are open in this console.`
                }
              />
            </p>
          )}
        </div>

        <aside className="meridian-sessions__aside" aria-label="Start or join a session">
          <h2 className="meridian-sessions__aside-title">Start or join</h2>
          {renderAbsorbedSessionProbe(context.bridge.source)}
        </aside>
      </div>
    </section>
  );
}
