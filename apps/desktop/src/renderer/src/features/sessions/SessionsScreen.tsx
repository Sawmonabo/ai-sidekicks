// The sessions destination's screen, the window's start screen: a heading, and under it the view a
// window shows while it holds no session. It draws no list or attention panel, so it renders on
// the default route before the background service answers.

import "./SessionsScreen.css";

import { type WindowStore } from "#renderer/store/window/store.js";
import { EmptySessionView } from "./components/EmptySessionView.js";

/** Props for `SessionsScreen`. */
export interface SessionsScreenProps {
  readonly frameStore: WindowStore;
}

/** The all-sessions destination: its heading and the empty view; no list until a read fills one. */
export function SessionsScreen(props: SessionsScreenProps): React.JSX.Element {
  return (
    <section className="meridian-sessions" aria-label="Sessions">
      <header className="meridian-sessions__head">
        <h1 className="meridian-sessions__title">Sessions</h1>
      </header>
      <EmptySessionView frameStore={props.frameStore} />
    </section>
  );
}
