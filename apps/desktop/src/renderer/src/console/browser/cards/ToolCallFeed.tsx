// The agent's browser tool calls, as the pane shows them.
//
// `Spec-023 §Console Design (Meridian)` 12.7 renders nothing of its own — "every
// invocation renders as an ordinary tool row in the timeline" — and 12.8 puts every
// call under the same authorization and approval rules as any other tool. What the
// PANE adds is proximity: the call about to act on the page a person is watching,
// beside that page.
//
// EVERY CALL ARRIVES AWAITING ADJUDICATION, and that is a fact about the relay rather
// than a default this component chose. The relay carries an invocation the daemon has
// not yet answered; the answer travels back over the response operation, and the
// outcome a card renders for an answered call comes from whatever settled it. Nothing
// here derives an outcome, and nothing here adjudicates — 12.8's whole point is that
// the browser carves nothing out of the approval path.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { BrowserToolCallCard } from "./ToolCallCard.js";
import type { ToolCallReading } from "./tool-call-relay.js";

export interface ToolCallFeedProps {
  readonly reading: ToolCallReading;
}

export function ToolCallFeed(props: ToolCallFeedProps): React.JSX.Element {
  const { reading } = props;

  if (reading.kind === "refused") {
    return <InlineRefusal {...reading.refusal} />;
  }
  if (reading.kind === "reading") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Tool calls not relayed"
        detail="Nothing has been relayed to this window about what the agent is doing in this page. This is not a claim that it is doing nothing."
      />
    );
  }
  if (reading.kind === "ended") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Relay finished"
        detail="The producer relaying this session's browser tool calls finished, so this list stops where it stopped."
      />
    );
  }
  if (reading.calls.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No tool calls yet"
        detail="No agent has called a page tool in this session since this pane opened."
      />
    );
  }

  return (
    <div className="meridian-browser-cards">
      {reading.calls.map((call) => (
        <BrowserToolCallCard
          key={call.toolCallId}
          toolCallId={call.toolCallId}
          toolName={call.toolName}
          argumentsJson={call.argumentsJson}
          owningRunLabel={call.owningRunLabel}
          // The relay carries an invocation the daemon has not answered. What settles
          // it travels back over the response operation, and a settled outcome is
          // rendered by the timeline's own row for the same call.
          outcome={{ status: "awaiting-adjudication" }}
        />
      ))}
    </div>
  );
}
