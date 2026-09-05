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

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  FOLLOWING_ADDRESS_FIELD,
  type AddressFieldState,
} from "../../browser/address-field-model.js";
import { useSubjectScopedState } from "../../store/index.js";

/** The field's state and its writer, for the pane this render is for. */
export interface PaneAddressField {
  readonly addressField: AddressFieldState;
  readonly setAddressField: (field: AddressFieldState) => void;
}

/**
 * Hold the address field's state for one pane.
 *
 * The subject is the `(bridge, paneId)` pair and the console's one holder keeps the
 * value bound to it, which answers DURING RENDER rather than in an effect: an effect
 * runs one pass after the pass that renders the field and wires the submit handler,
 * and that first pass is the one an Enter can reach. A render for a different pane
 * reads the seed — `FOLLOWING_ADDRESS_FIELD`, the resting state a pane opens in — so
 * the replacement pane follows its own reported location and has nothing of the
 * previous one to submit.
 */
export function usePaneAddressField(bridge: ConsoleBridge, paneId: string): PaneAddressField {
  const { value: addressField, publish: setAddressField } = useSubjectScopedState(
    bridge,
    paneId,
    () => FOLLOWING_ADDRESS_FIELD,
  );
  return { addressField, setAddressField };
}
