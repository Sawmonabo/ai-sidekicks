// The sessions destination's frame.
//
// It draws no session list and no attention panel. The node's session directory and the
// attention reading have no daemon call behind them, so no composition mounts the
// binding that would read them, and a surface that reached for that binding would throw
// on the default route.

import "./sessions.css";

/** The all-sessions destination: its frame, with no list until a read can fill one. */
export function SessionsSurface(): React.JSX.Element {
  return (
    <section className="meridian-sessions" aria-label="Sessions">
      <header className="meridian-sessions__head">
        <h1 className="meridian-sessions__title">Sessions</h1>
      </header>
    </section>
  );
}
