// What stands in the run graph's box while there is no drawing to show: the canvas code or the
// workflow version it draws is still being read, or could not be.

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

/** Props for `UnloadedRunGraph`: still loading, or failed with the press that loads it again. */
export type UnloadedRunGraphProps =
  | { readonly state: "loading" }
  | {
      readonly state: "failed";
      readonly onRetry: () => void;
      /** The attempt that failed, so a retry that fails again says so again. */
      readonly attempt: unknown;
    };

/**
 * `Loading run graph…` after the session's short delay, and `Couldn't load run graph` with
 * `Retry` once it failed, never the failure's own text. Both use only styles that load with the
 * page, since one from the graph chunk would be missing exactly when the chunk failed.
 */
export function UnloadedRunGraph(props: UnloadedRunGraphProps): React.JSX.Element {
  const clock = useClock();
  return props.state === "loading" ? (
    <LoadingNotice clock={clock} placement="block" title="Loading run graph…" />
  ) : (
    <Nothing
      kind="error"
      placement="block"
      title="Couldn't load run graph"
      action={<TryAgainButton word="Retry" onPress={props.onRetry} />}
      attempt={props.attempt}
    />
  );
}
