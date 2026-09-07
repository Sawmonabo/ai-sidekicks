// The honest-chrome plane, composed: the chip, the banners, and the two notices.
//
// MOUNTED ABOVE THE FRAME'S REFUSAL BANNERS AND NOT INSIDE THEM. The frame's banner
// stack is a queue of raised refusals with dismissal and announcement semantics of
// its own; these lines are standing conditions that clear when their fact clears.
// Pushing them through `raiseBanner` would make a window's connection state
// dismissible and would leave the store holding a banner nothing clears if a report
// arrived while the frame was between renders.
//
// A WINDOW THAT WAS TOLD NOTHING SAYS NOTHING. The strip renders only once something
// has been reported or a notice stands. That is the same rule the chip's own
// `not-checked` absence carries, applied to the strip: this build's live bridge has
// no channel for the shell's status, so a frame-wide bar reading "not checked" would
// be permanent furniture on every window making a claim about a supervisor nobody
// asked. Where the absence itself is the subject — the daemon settings page — the
// chip is mounted directly and names it.

import { useCallback } from "react";

import { SHELL_DETAIL_DESTINATION, useShellState, type FrameStore } from "../../store/index.js";
import { DaemonChip } from "./DaemonChip.js";
import { ShellBanners } from "./ShellBanners.js";
import { ShellNotices } from "./ShellNotices.js";

export interface ShellChromeProps {
  readonly frameStore: FrameStore;
  /** The manual retry, where the window's host can perform one. */
  readonly onRetry?: () => void;
}

/** Everything the frame says about the shell it is running against. */
export function ShellChrome(props: ShellChromeProps): React.JSX.Element | null {
  const { frameStore, onRetry } = props;
  const shellState = useShellState(frameStore);
  // The chip's destination, resolved here because this is the level that holds the
  // store. An in-window navigation through the route value the shell vocabulary
  // declares — never a hash composed by hand, which would be a second implementation
  // of the routing family's own formatter.
  const openShellDetail = useCallback(() => {
    frameStore.navigate(SHELL_DETAIL_DESTINATION.route);
  }, [frameStore]);
  const hasReport =
    shellState.connection.kind !== "unreported" ||
    shellState.transport !== undefined ||
    shellState.keystore !== undefined ||
    shellState.sessionRecovery !== undefined;
  if (!hasReport) {
    return null;
  }
  return (
    <div className="meridian-shell-state">
      <div className="meridian-shell-state__status">
        <DaemonChip connection={shellState.connection} onOpenDetail={openShellDetail} />
      </div>
      <ShellBanners state={shellState} onRetry={onRetry} />
      <ShellNotices transport={shellState.transport} keystore={shellState.keystore} />
    </div>
  );
}
