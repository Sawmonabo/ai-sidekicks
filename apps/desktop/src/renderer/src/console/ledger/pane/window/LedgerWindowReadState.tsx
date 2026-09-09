// Where this window is in its own read: still filling, catching up, or neither.
//
// WHAT WAS MISSING. The store has carried both facts since it was written —
// `initialised` is false until a read response lands, and `degradedCause` is sticky
// while the projection is known-incomplete and cleared only by a completed re-pull —
// and neither reached the pane. So a session whose first read was in flight rendered
// exactly like a session that had never had anything happen in it, and a window that
// knew it was missing rows said so nowhere a person looks.
//
// TWO ARMS AND NEVER BOTH, AND THE STANDING CAUSE LEADS. The shells used to win, on
// the reading that a window which has not been read yet has nothing to be behind ON —
// and that reading is false for the one cause a first read can raise. `read-failed` is
// marked when the read is refused or rejects, which leaves the store uninitialised and
// the cause standing, so the pane drew `aria-busy` loading shells for as long as the
// failure lasted and never said the read had already ended. The cause decides at any
// point in the read: while one stands this names it, and only a window with no cause
// and no first read yet is still filling.
//
// THE CATCHING-UP MARK IS STICKY IN THE STORE'S OWN SENSE, which is the one that
// matters: the cause is cleared by the completed re-pull and by nothing else, so the
// mark stands for exactly as long as the window is behind and goes when the re-read
// that closes the hole finishes. Nothing here polls, times out, or dismisses it.
//
// THE LIVE REGION IS THE ABSENCE'S OWN. `Nothing`'s `computing` kind already carries
// `role="status"`, so the element around it carries none — two nested status regions
// announce the same sentence twice.
//
// AND IT NAMES THE CAUSE RATHER THAN SUMMARISING IT. The five causes are five
// different things to know — a stream this store could not follow at all is not a read
// that failed — so the cause is rendered as itself, in mono, beside one sentence that
// says what is being done about it.

import {
  useSessionStore,
  type SessionStore,
  type SessionStoreState,
} from "../../../store/index.js";
import { useLedgerFirstReadSettled } from "./ledger-first-read.js";
import { Nothing } from "../../../primitives/index.js";

/**
 * How many row shells a window that has not been read yet draws.
 *
 * Twelve is a screen of ledger at this density: enough that the shape on screen is
 * the shape the rows will take, and few enough that the first read replacing them is
 * one repaint rather than a page of shells collapsing.
 */
const LOADING_SHELL_COUNT = 12;

/** The shells, minted once: twelve identical elements need twelve stable keys and nothing else. */
const LOADING_SHELL_KEYS: readonly string[] = Object.freeze(
  Array.from({ length: LOADING_SHELL_COUNT }, (_unused, index) => `shell-${String(index)}`),
);

export interface LedgerWindowReadStateProps {
  readonly sessionStore: SessionStore;
}

/**
 * The window's read state, or nothing at all once it has one and is keeping up.
 *
 * Read through the store's own selectors rather than off a snapshot, so this follows
 * a navigation that changes which session the pane is a log of — and so neither fact
 * is copied into a second holder that could disagree with the store it came from.
 */
export function LedgerWindowReadState(props: LedgerWindowReadStateProps): React.JSX.Element | null {
  // The same reading the viewport's empty arm takes, through the same hook: two
  // surfaces speaking about one moment, and never from two selectors.
  const firstReadSettled = useLedgerFirstReadSettled(props.sessionStore);
  const degradedCause = useSessionStore(props.sessionStore, readDegradedCause);
  // ASKED FIRST, so a first read that has already failed says so instead of drawing
  // shells for a read that is over. Nothing here mints a second sentence for that
  // case: the copy below says what is wrong and what is being done about it, and the
  // cause beside it — `read-failed` rather than `sequence-gap` — is what distinguishes
  // the read that ended from the projection that is behind.
  if (degradedCause !== undefined) {
    return (
      <div className="meridian-ledger-window-catch-up">
        <Nothing
          kind="computing"
          placement="surface"
          title="Catching up."
          detail="Entries this window was told about have not arrived. It re-reads from the last position it kept, and this clears when that read lands."
        />
        <span className="meridian-ledger-window-catch-up__cause">{degradedCause}</span>
      </div>
    );
  }
  if (!firstReadSettled) {
    return (
      <div
        className="meridian-ledger-window-skeleton"
        role="status"
        aria-busy="true"
        aria-label="Reading this session's entries."
      >
        {LOADING_SHELL_KEYS.map((key) => (
          <span key={key} className="meridian-ledger-window-skeleton__row" aria-hidden="true" />
        ))}
      </div>
    );
  }
  return null;
}

/** Why the projection is known-incomplete, or `undefined` while it is not. */
function readDegradedCause(state: SessionStoreState): string | undefined {
  return state.degradedCause;
}
