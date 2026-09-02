// The attachment picker's seat: where files would be attached to a send.
//
// WHY THE PICKER ASKS BEFORE IT OFFERS. The effective allow-list is a HINT and never
// a gate — the daemon decides what it admits — but it is also the only thing that
// makes the picker honest about what will happen. So pressing "Attach files" reads
// the allow-list first, and what comes back decides what a person is offered.
//
// TODAY THAT READ REFUSES, AND THE REFUSAL IS THE POINT. The ingest wire is on the
// console's growth slate: no method-name table is registered for the three ingest
// calls, so the growth port answers every one of them with a typed refusal naming
// the row and the document that owes it. The seat renders that refusal verbatim
// rather than opening a file dialog — because the three-call ingest cannot complete,
// and a dialog that takes a person's file and then cannot deliver it is the one
// outcome worse than saying so up front.
//
// NOTHING HERE CLAIMS DELIVERY. There is no code path in this file that adds an
// attachment to a send, and there will not be one until the ingest completes and
// says so: an attachment is delivered when its ingest settles, never when a chip
// appears. Live delivery on a steer additionally waits on the typed attachment arm,
// which the registered intervention payload does not carry — the `replacementSend`
// leg has no attachment member at all.

import { useCallback, useState } from "react";
import { InlineRefusal, Nothing, formatByteQuantity } from "../../../console/primitives/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { ATTACHMENT_CARRIER_COUNT_CAP } from "./accessory-bounds.js";

export interface AttachmentPickerSeatProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}

type PickerState =
  | { readonly phase: "unasked" }
  | { readonly phase: "asking" }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal }
  | {
      readonly phase: "offered";
      readonly contentTypes: readonly string[];
      readonly maximumByteLength: number;
    };

export function AttachmentPickerSeat(props: AttachmentPickerSeatProps): React.JSX.Element {
  const [state, setState] = useState<PickerState>({ phase: "unasked" });
  const { bridge, sessionId } = props;

  const readAllowList = useCallback(() => {
    setState({ phase: "asking" });
    void bridge.growth.artifactAllowlistRead({ sessionId }).then((outcome) => {
      if (outcome.status === "unavailable") {
        setState({ phase: "refused", refusal: outcome });
        return;
      }
      setState({
        phase: "offered",
        contentTypes: outcome.value.contentTypes,
        maximumByteLength: outcome.value.maximumByteLength,
      });
    });
  }, [bridge, sessionId]);

  return (
    <div className="meridian-attachment-seat">
      <button
        type="button"
        className="meridian-attachment-seat__action"
        aria-busy={state.phase === "asking"}
        onClick={readAllowList}
      >
        Attach files
      </button>
      <AttachmentPickerAnswer state={state} />
    </div>
  );
}

/**
 * What the allow-list read answered.
 *
 * The served arm is reachable only from a fixture that serves the growth port, and
 * it is written out rather than left for later so the surface has one shape whether
 * or not the wire is registered — the day the wire lands, this file's diff is the
 * port entry's, not this component's.
 */
function AttachmentPickerAnswer(props: { readonly state: PickerState }): React.JSX.Element | null {
  const { state } = props;
  if (state.phase === "unasked") {
    return null;
  }
  if (state.phase === "asking") {
    return <Nothing kind="computing" title="Reading what this session accepts." />;
  }
  if (state.phase === "refused") {
    return <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />;
  }
  return (
    <p className="meridian-attachment-seat__hint">
      Up to {String(ATTACHMENT_CARRIER_COUNT_CAP)} files on one send, each at most{" "}
      {formatByteQuantity(state.maximumByteLength).text}. The session accepts{" "}
      {state.contentTypes.join(", ")}. This is a hint from the daemon, not a gate the console
      enforces.
    </p>
  );
}
