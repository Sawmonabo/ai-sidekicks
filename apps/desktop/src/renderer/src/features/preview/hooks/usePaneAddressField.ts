// The address field's state, held for the pane it was typed for. What the field means lives in
// `address-field-model.ts`; this module owns whose it is, which a reused component instance
// gets wrong.
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { FOLLOWING_ADDRESS_FIELD, type AddressFieldState } from "../address-field-model.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";

/** The field's state and its writer, for the pane this render is for. */
export interface PaneAddressField {
  readonly addressField: AddressFieldState;
  readonly setAddressField: (field: AddressFieldState) => void;
}

/**
 * Hold the address field's state for one pane. The subject is `(bridge, paneId)`, resolved during
 * render rather than in an effect, since the first pass is the one an Enter can reach. A
 * different pane reads the seed, so it has nothing of the previous pane to submit.
 */
export function usePaneAddressField(bridge: PlatformBridge, paneId: string): PaneAddressField {
  const { value: addressField, publish: setAddressField } = useSubjectScopedState(
    bridge,
    paneId,
    () => FOLLOWING_ADDRESS_FIELD,
  );
  return { addressField, setAddressField };
}
