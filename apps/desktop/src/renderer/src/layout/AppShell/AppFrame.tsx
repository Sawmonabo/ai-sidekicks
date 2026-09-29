// The window's chrome, wrapped in the announcer that outlives every surface in it.
//
// THE WINDOW'S ONE LIVE ANNOUNCER IS MOUNTED HERE. `LiveAnnouncerProvider` renders
// its two regions above the frame root, so they are outside the `inert` wrapper
// `FrameChrome.tsx` hangs on its background and keep speaking while a dialog is
// open — which is when a refusal is most likely to be raised. And the frame is the
// widest thing that exists once per window: an announcer per surface would be N
// regions competing to be the one a reader hears, which is the defect the primitive
// exists to make unrepresentable. The frame is also its first consumer — see
// `hooks/useRefusalBannerAnnouncements.ts`.
//
// AND IT RUNS ON THE WINDOW'S CLOCK, not on the wall clock. The announcer arms one
// timeout — the hold before a standing message is cleared and the next one is spoken —
// and that is a timer like any other, so the rule that the fixture clock is the only
// clock the renderer reads in fixture mode binds it. Left on `RealClock` it was the one
// subsystem in a fixture window still reading wall time: a refusal raised by a scenario
// beat cleared on how fast the runner happened to be, so what a reader hears and what a
// screenshot captures both depended on the host. `useClock` is the same answer
// `app/hooks/useUiStateStore.ts` and `app/hooks/useSessionStoreRegistry.ts` ask
// for, and the frame is where it is asked because `primitives/` sits below `bridge/` in
// the family DAG and cannot ask for itself.
//
// THE CHROME ITSELF IS `FrameChrome.tsx`, and the split is not only the
// one-component rule: the banner announcement hook has to run BELOW this provider —
// context is read by tree position — and a component cannot consume a provider it
// renders itself.
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { FrameChrome, type FrameChromeProps } from "./FrameChrome.js";

import "./app-frame.css";

/**
 * What a caller hands the frame.
 *
 * Declared beside the body that reads every member of it and named here for the
 * component callers mount, so the contract has one declaration and the two modules
 * cannot drift apart.
 */
export type AppFrameProps = FrameChromeProps;

/** The window's chrome, wrapped in the announcer that outlives every surface in it. */
export function AppFrame(props: AppFrameProps): React.JSX.Element {
  const announcerClock = useClock();
  return (
    <LiveAnnouncerProvider clock={announcerClock}>
      <FrameChrome {...props} />
    </LiveAnnouncerProvider>
  );
}
