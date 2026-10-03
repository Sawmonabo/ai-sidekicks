// The color scheme: read back at mount, written when a person chooses it, and disclosed when
// the write is refused.
//
// The write happens in the choose act, not in an effect on `schemePreference`: such an effect
// cannot tell a choice from a hydration that just applied a stored value, so a slow read would
// write the default back over the stored preference.

import { useCallback, useEffect, useRef } from "react";

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { SCHEME_PREFERENCE_KEY } from "@renderer/store/persistence/persistence-adapter.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { useWindowStore } from "@renderer/store/window/hooks/useWindowStore.js";
import { type WindowStore } from "@renderer/store/window/window-store.js";
import { isSchemePreference, type SchemePreference } from "@renderer/styles/tokens.js";

/** The scheme the frame renders, and the one act that changes it. */
export interface UseSchemePreferenceResult {
  readonly schemePreference: SchemePreference;
  readonly chooseScheme: (preference: SchemePreference) => void;
}

/** This window's color scheme, read back at mount and written when it is chosen. */
export function useSchemePreference(
  frameStore: WindowStore,
  uiStateStore: UiStateStore,
): UseSchemePreferenceResult {
  const schemePreference = useWindowStore(frameStore, (state) => state.schemePreference);

  const schemeWasChosenRef = useRef(false);
  const chooseScheme = useCallback(
    (preference: SchemePreference) => {
      schemeWasChosenRef.current = true;
      frameStore.setSchemePreference(preference);
      // Only the fulfilled result is handled: a refusal is the store's declared failure, and a
      // rejection is a defect that should surface unhandled.
      void uiStateStore.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", preference).then((result) => {
        if (result.outcome === "refused") {
          frameStore.raiseRefusalBanner(describeUnsavedScheme(result.refusal));
        }
      });
    },
    [frameStore, uiStateStore],
  );

  useEffect(() => {
    let abandoned = false;
    void uiStateStore.readGlobal(SCHEME_PREFERENCE_KEY).then((record) => {
      // A choice made while the read was in flight is newer and stands.
      if (abandoned || schemeWasChosenRef.current || record === undefined) {
        return;
      }
      const stored = record.value;
      if (isSchemePreference(stored)) {
        frameStore.setSchemePreference(stored);
      }
    });
    return () => {
      abandoned = true;
    };
  }, [frameStore, uiStateStore]);

  return { schemePreference, chooseScheme };
}

/**
 * What a refused scheme write says on the frame.
 *
 * The store's sentence is carried whole after the frame's own consequence: the scheme applies
 * to this window but will not survive a reload. The refusal keeps its code and origin.
 */
function describeUnsavedScheme(refusal: Refusal): Refusal {
  return refuse(
    refusal.origin,
    refusal.code,
    `The color scheme applies to this window but could not be saved, so a reload will not bring it back. ${refusal.detail}`,
  );
}
