// The one line a safe start shows above the screen: the app came back after repeated problems
// without the windows it had, and `Restore windows` brings them back.

/** What the safe-start line acts through. */
export interface SafeStartNoticeProps {
  /** Reopen every window from the kept layout. */
  readonly onRestoreWindows: () => void;
}

/** Says the windows were not restored, with the control that restores them. */
export function SafeStartNotice(props: SafeStartNoticeProps): React.JSX.Element {
  return (
    <p className="meridian-frame__notice">
      {"The app restarted after repeated problems and did not reopen its windows."}
      <button
        type="button"
        className="meridian-action-button meridian-action-button--small meridian-action-button--outline"
        onClick={props.onRestoreWindows}
      >
        Restore windows
      </button>
    </p>
  );
}
