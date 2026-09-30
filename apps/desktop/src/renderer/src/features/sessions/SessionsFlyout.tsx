// The sessions destination's frame: a heading only. It draws no list or attention panel
// and reaches for no binding, so it renders on the default route.

import "./sessions.css";

/** The all-sessions destination: its frame, with no list until a read can fill one. */
export function SessionsFlyout(): React.JSX.Element {
  return (
    <section className="meridian-sessions" aria-label="Sessions">
      <header className="meridian-sessions__head">
        <h1 className="meridian-sessions__title">Sessions</h1>
      </header>
    </section>
  );
}
