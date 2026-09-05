// The rows' hole, and the three different nothings it can hold.
//
// Its own module for the one-component rule, and the split puts the seat's absence
// where a reader looks for it: the pane above decides the chrome and the address, and
// this decides what stands in the body while the seat, the session, or the rows are
// not there.

import { Nothing } from "../../../primitives/index.js";
import { type SessionStore } from "../../../store/index.js";
import { type OwnerSlotProps, type TimelineRowRenderer } from "../../../seats/index.js";
import { LedgerFeed } from "./LedgerFeed.js";

export interface TimelineRowHostProps extends OwnerSlotProps<TimelineRowRenderer> {
  readonly sessionStore: SessionStore | undefined;
  readonly channelId?: string;
}

/**
 * The rows' hole, and the three different nothings it can hold.
 *
 * The three are kept apart because a person's next move differs (rule 8): a seat
 * nobody has filled means the feature has not shipped; a route that names no session
 * means there is nothing to be a log OF; and a filled seat over an open session with
 * no rows means this session has not done anything yet. Collapsing any two of them
 * would tell somebody their session was empty when the truth is that the console
 * cannot draw it, or has not been asked to.
 *
 * The third is the FEED's to render rather than this file's — `LedgerViewport` shows
 * it inside the scroll container, where a row would appear the moment one arrived —
 * so the empty session is not a case here at all.
 */
export function TimelineRowHost(props: TimelineRowHostProps): React.JSX.Element {
  const body = props.body;
  if (body === undefined) {
    return (
      <div className="meridian-pane__body">
        <Nothing
          kind="empty"
          placement="surface"
          title="The timeline rows have not been built yet."
          detail="The pane is reserved for them — nothing here failed, and nothing is missing from this session."
        />
      </div>
    );
  }
  if (props.sessionStore === undefined) {
    return (
      <div className="meridian-pane__body">
        <Nothing
          kind="not-loaded"
          placement="surface"
          title="No session is open in this pane."
          detail="Open a session and its log appears here."
        />
      </div>
    );
  }
  return (
    <div className="meridian-pane__body">
      <LedgerFeed
        sessionStore={props.sessionStore}
        renderTimelineRow={body}
        // Named for what the feed is a log of, because the label is what a screen
        // reader announces when it enters the box — and "Session timeline" over a
        // channel-scoped window says the log is the session's when it is not.
        feedLabel={props.channelId === undefined ? "Session timeline" : "Channel timeline"}
        {...(props.channelId === undefined ? {} : { channelId: props.channelId })}
      />
    </div>
  );
}
