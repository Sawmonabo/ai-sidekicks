// The agent's browser tool calls, as the pane shows them.
//
// The page-tool surface renders nothing of its own — every invocation renders as an
// ordinary tool row in the timeline — and every call is under the same authorization
// and approval rules as any other tool. What the
// PANE adds is proximity: the call about to act on the page a person is watching,
// beside that page.
//
// AND A RELAY THAT STOPPED STILL HAS ITS CALLS, however it stopped. The terminal
// notice and the rows are two different facts — the subscription is over, and these
// invocations were made — so a terminal arm renders its notice ABOVE the same list the
// live arm renders rather than instead of it. A feed that swapped the list for the
// sentence deleted every call the session had made at the moment the stream stopped.
// That holds for the REFUSED arm as much as the ended one, which is why this component
// has one list and three leading notices rather than a return per arm: an iterator that
// throws after relaying six invocations leaves six true rows on screen, and replacing
// them with an error is the feed claiming the window knows nothing about a page it has
// been reporting on all along.
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

  // The one arm that carries no list, taken first so every arm below reads `calls`
  // off the reading without a branch per kind.
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
  const { calls } = reading;
  // Only the LIVE arm collapses to an absence, and only while it is empty. A relay
  // that finished or broke having relayed nothing has something of its own to say,
  // and "no agent has called a page tool" is not it.
  if (reading.kind === "served" && calls.length === 0) {
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
    <>
      {reading.kind === "refused" ? <InlineRefusal {...reading.refusal} /> : null}
      {reading.kind === "ended" ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Relay finished"
          detail="The producer relaying this session's browser tool calls finished, so this list stops where it stopped."
        />
      ) : null}
      {calls.length === 0 ? null : (
        <div className="meridian-browser-cards">
          {calls.map((call) => (
            <BrowserToolCallCard
              key={call.toolCallId}
              toolCallId={call.toolCallId}
              toolName={call.toolName}
              argumentsJson={call.argumentsJson}
              owningRunLabel={call.owningRunLabel}
              // The relay carries an invocation the daemon has not answered. What
              // settles it travels back over the response operation, and a settled
              // outcome is rendered by the timeline's own row for the same call.
              outcome={{ status: "awaiting-adjudication" }}
            />
          ))}
        </div>
      )}
    </>
  );
}
