// Whether this window will remember the choice above it.
//
// The block sits under the scheme control on purpose. That control's own sentence
// says the choice "is remembered for the next start", and whether that is TRUE is a
// property of the store rather than of the control — on the in-memory adapter the
// scheme applies and is gone at the next launch, and a person had no way to learn
// that except by restarting and finding it gone.
//
// The block owns the read and the frame; `StoreStateBody.tsx` owns what each of the
// three states draws.

import type { ReactNode } from "react";

import { type UiStateStore } from "../../../../persistence/index.js";
import { StoreStateBody } from "./StoreStateBody.js";
import { useStoreStateReading } from "./store-state-reading.js";

export function StoreStateBlock(props: { readonly uiStateStore: UiStateStore }): ReactNode {
  const reading = useStoreStateReading(props.uiStateStore);
  return (
    <section className="meridian-settings-page__block" aria-label="What this window remembers">
      <h3 className="meridian-settings-page__block-title">What this window remembers</h3>
      <StoreStateBody reading={reading} />
    </section>
  );
}
