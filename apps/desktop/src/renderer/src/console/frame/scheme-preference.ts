// The colour scheme: hydrated on a read, persisted on an act, disclosed on a refusal.
//
// The scheme is the one window preference that has to survive a reload, so it is the
// one thing the frame reads back at mount and writes at the moment a person changes
// it. Three decisions hold it together, and each replaced something that was quietly
// wrong:
//
//   • **The write does NOT ride a `schemePreference` effect.** Such an effect cannot
//     tell a person's choice from the hydration that just applied a stored one, so in
//     the window before the read settles it writes the default back over the stored
//     preference — a preference that survives every reload except the ones where the
//     disk was slow. Persisting at the ACT makes that unrepresentable and leaves the
//     hydration free to be a pure read.
//   • **A choice made while the read is in flight is the newer fact and stands.**
//     The hydration checks that before applying, so a fast click never loses to a
//     slow disk.
//   • **A refused write is disclosed, not discarded.** `writeGlobal` declares its
//     failure as a VALUE, so a caller that fires it and walks away cannot tell a
//     stored preference from one that was refused for quota or by a failing adapter.
//     The frame took the choice before the write was attempted and keeps it, so the
//     honest disclosure is not "that did not work" — it is "that worked for this
//     window and will not come back", which is a different sentence and the only
//     true one.

import { useCallback, useEffect, useRef } from "react";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { SCHEME_PREFERENCE_KEY, type UiStateStore } from "../persistence/index.js";
import { useFrameStore, type FrameStore } from "../store/index.js";
import { isSchemePreference, type SchemePreference } from "../tokens/index.js";

/** The scheme the frame renders, and the one act that changes it. */
export interface SchemePreferenceSurface {
  readonly schemePreference: SchemePreference;
  readonly chooseScheme: (preference: SchemePreference) => void;
}

/** This window's colour scheme, read back at mount and written when it is chosen. */
export function useSchemePreference(
  frameStore: FrameStore,
  uiStateStore: UiStateStore,
): SchemePreferenceSurface {
  const schemePreference = useFrameStore(frameStore, (state) => state.schemePreference);

  const schemeWasChosenRef = useRef(false);
  const chooseScheme = useCallback(
    (preference: SchemePreference) => {
      schemeWasChosenRef.current = true;
      frameStore.setSchemePreference(preference);
      // Only the FULFILLED result is handled. A refusal is a returned value, so
      // this arm is the store's declared failure; a rejection is the store's own
      // defect, and leaving it unhandled is how it gets found rather than filed
      // under a storage code nobody would look for it under.
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
      // A choice made while the read was in flight is the newer fact and stands.
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
 * The store's own sentence is carried WHOLE rather than reworded — the refusal
 * grammar renders the code verbatim and the message as its author wrote it — and the
 * frame states the consequence only it knows in front of it: the scheme is applied,
 * and it will not survive a reload. The refusal keeps its code and its origin, so the
 * banner still names the subsystem that refused and the string a person would paste
 * into a search.
 */
function describeUnsavedScheme(refusal: ConsoleRefusal): ConsoleRefusal {
  return refuse(
    refusal.origin,
    refusal.code,
    `The colour scheme applies to this window but could not be saved, so a reload will not bring it back. ${refusal.detail}`,
  );
}
