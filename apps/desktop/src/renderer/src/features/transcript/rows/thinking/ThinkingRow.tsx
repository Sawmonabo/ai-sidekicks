// The reasoning row's body: the streaming tail, the read's result, and the one expand control.
// The tail and the read are not ranked: a turn expanded mid-stream shows both, tail first.
// The control is absent, not disabled, on a row with no run attribution: the read is run-scoped,
// and a disabled control would claim an action that exists but is not permitted.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import type {
  ReasoningEntry,
  ReasoningSurfaceReadResponse,
} from "@ai-sidekicks/contracts/transcript/operations";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { type PublishedText } from "../../reveal/published-text.js";
import {
  REASONING_AVAILABILITY_COPY,
  reasoningTailOf,
  type ReasoningReading,
} from "./reasoning-reading.js";

import "./ThinkingRow.css";

/** What a mount hands the reasoning row. */
export interface ThinkingRowProps {
  /** The run this row's reasoning belongs to, or `undefined` where none is attributed. */
  readonly runId: RunId | undefined;
  /** Text the reveal engine is publishing for this row right now, while it streams. */
  readonly liveText: PublishedText | undefined;
  readonly reading: ReasoningReading;
  /** Ask the daemon for this run's reasoning; handed the control that was pressed. */
  readonly onExpand: (control: HTMLElement) => void;
}

/** The reasoning body: the streaming tail, the read's result and the expand control. */
export function ThinkingRow(props: ThinkingRowProps): React.JSX.Element {
  return (
    <div className="meridian-reasoning-surface">
      {renderReasoningTail(props.liveText)}
      {renderReasoningReading(props.reading)}
      {renderExpandControl(props.runId, props.reading, props.onExpand)}
    </div>
  );
}

/**
 * The newest lines of a turn that is still streaming, or nothing.
 *
 * `aria-live` is deliberately absent: the lines change many times a second, and a live region
 * would read a reasoning trace aloud over whatever a person was doing.
 */
function renderReasoningTail(liveText: PublishedText | undefined): React.ReactNode {
  if (liveText === undefined) {
    return null;
  }
  const lines = reasoningTailOf(liveText);
  if (lines.length === 0) {
    return null;
  }
  return (
    <ol className="meridian-reasoning-surface__tail" aria-label="the newest reasoning lines">
      {lines.map((line, index) => (
        // The window slides, so a line's text is unstable across frames while its position is.
        // An index key remounts nothing, and this fixed-size window is never reordered.
        <li key={index} className="meridian-reasoning-surface__tail-line">
          {line}
        </li>
      ))}
    </ol>
  );
}

/** Whatever the read has said so far, in the shape that fact takes. */
function renderReasoningReading(reading: ReasoningReading): React.ReactNode {
  switch (reading.status) {
    case "not-asked":
      return null;
    case "reading":
      return <Nothing kind="not-loaded" placement="block" title="Reading this turn's reasoning." />;
    case "refused":
      // The daemon's own sentence; its code goes to no screen.
      return (
        <Nothing
          kind="error"
          placement="block"
          title={reading.refusal.detail}
          attempt={reading.refusal}
        />
      );
    case "read":
      return renderAvailabilityArm(reading.response);
  }
}

/** One arm of the closed availability discriminant, rendered as itself. */
function renderAvailabilityArm(response: ReasoningSurfaceReadResponse): React.ReactNode {
  if (response.availability === "available" && response.reasoningEntries.length > 0) {
    return (
      <>
        {renderReasoningEntries(response.reasoningEntries)}
        {response.hasMore ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="More reasoning follows this page."
            detail="This page is bounded and the continuation has not been asked for."
          />
        ) : null}
      </>
    );
  }
  const copy = REASONING_AVAILABILITY_COPY[response.availability];
  return <Nothing kind="empty" placement="block" title={copy.title} detail={copy.detail} />;
}

/** The entries themselves, ordered by the sequence the daemon put them in. */
function renderReasoningEntries(entries: readonly ReasoningEntry[]): React.ReactNode {
  return (
    <ol className="meridian-reasoning-surface__entries" aria-label="reasoning entries">
      {entries.map((entry) => (
        <li key={entry.sequence}>
          {/* Preformatted, so text copied out of it keeps its lines. */}
          <pre className="meridian-reasoning-surface__entry">{entry.content}</pre>
        </li>
      ))}
    </ol>
  );
}

/**
 * The one offer this row makes.
 *
 * Absent where the read cannot address the row, and once the read has answered: a second press
 * would re-ask an answered question, and this row holds no continuation cursor. A refusal keeps
 * the control so a briefly down transport can be retried; the label says which press it is.
 */
function renderExpandControl(
  runId: RunId | undefined,
  reading: ReasoningReading,
  onExpand: (control: HTMLElement) => void,
): React.ReactNode {
  if (runId === undefined || reading.status === "reading" || reading.status === "read") {
    return null;
  }
  return (
    <button
      type="button"
      className="meridian-reasoning-surface__expand"
      onClick={(event) => {
        onExpand(event.currentTarget);
      }}
    >
      {reading.status === "refused" ? "Try the read again" : "Show reasoning"}
    </button>
  );
}
