// The announcer's regions render above the frame, outside the `inert` background, so refusals
// are still spoken while a dialog is open. It runs on the window clock, so a fixture window
// never reads wall time. The chrome is a separate module because the banner announcement hook
// must run below the provider, and a component cannot consume a provider it renders itself.
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { FrameChrome, type FrameChromeProps } from "./FrameChrome.js";

import "./AppFrame.css";

/** The props a caller hands the frame; declared beside the chrome that reads them. */
export type AppFrameProps = FrameChromeProps;

/** The window's chrome, wrapped in the announcer that outlives every view in it. */
export function AppFrame(props: AppFrameProps): React.JSX.Element {
  const announcerClock = useClock();
  return (
    <LiveAnnouncerProvider clock={announcerClock}>
      <FrameChrome {...props} />
    </LiveAnnouncerProvider>
  );
}
