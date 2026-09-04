// The address field's state, held for the pane it was typed for.
//
// Its own module beside `act-sequence.ts` and for that module's reason: the pane
// RENDERS, and the two pieces of state it carries between renders — which act may
// still report, and what somebody has typed into the destination field — are each a
// small rule that is testable without mounting a chrome around it.
//
// WHAT THE FIELD MEANS lives in `browser/address-field-model.ts`, which owns the
// following/editing pair and the two readings taken off it. This module owns only
// WHOSE it is, which is a different question and the one a reused component
// instance gets wrong.

import { useCallback, useState } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  FOLLOWING_ADDRESS_FIELD,
  type AddressFieldState,
} from "../../browser/address-field-model.js";

/**
 * A draft and the `(bridge, paneId)` it was typed against.
 *
 * The draft is not a fact about anything on its own: it is a destination somebody
 * typed for ONE pane on ONE bridge, and a component instance outlives both. A deck
 * that swaps which pane a slot holds reuses the instance, so the editing state
 * survived the swap while `navigation-state.ts`'s reading correctly went unread —
 * the replacement pane opened showing the previous pane's half-typed destination and
 * Enter dispatched that text to the NEW `paneId`. That is not a stale render; it is
 * one pane's destination navigating another pane.
 *
 * Both inputs are stamped because both decide where a submit goes: `browserNavigate`
 * is called on this bridge with this `paneId`, so a draft typed under either of the
 * other combinations is not a destination for this one.
 */
interface StampedAddressField {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
  readonly field: AddressFieldState;
}

/** The field's state and its writer, for the pane this render is for. */
export interface PaneAddressField {
  readonly addressField: AddressFieldState;
  readonly setAddressField: (field: AddressFieldState) => void;
}

/**
 * Hold the address field's state for one pane.
 *
 * The stamp is COMPARED DURING RENDER rather than cleared in an effect, which is the
 * shape `browser/navigation-state.ts` and `terminal/viewer-identity.ts` already take:
 * an effect runs one pass after the pass that renders the field and wires the submit
 * handler, and that first pass is the one an Enter can reach. A subject that does not
 * match reads `FOLLOWING_ADDRESS_FIELD` — the resting state a pane opens in — so the
 * replacement pane follows its own reported location and has nothing of the previous
 * one to submit.
 */
export function usePaneAddressField(bridge: ConsoleBridge, paneId: string): PaneAddressField {
  const [stamped, setStamped] = useState<StampedAddressField>({
    bridge,
    paneId,
    field: FOLLOWING_ADDRESS_FIELD,
  });
  const setAddressField = useCallback(
    (field: AddressFieldState): void => {
      setStamped({ bridge, paneId, field });
    },
    [bridge, paneId],
  );
  const addressField =
    stamped.bridge === bridge && stamped.paneId === paneId
      ? stamped.field
      : FOLLOWING_ADDRESS_FIELD;
  return { addressField, setAddressField };
}
