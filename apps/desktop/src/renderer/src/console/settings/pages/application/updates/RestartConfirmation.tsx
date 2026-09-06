import { DAEMON_SHUTDOWN_FLUSH_BUDGET_MS } from "../../../../core/index.js";
import { DerivedFigure, formatDuration } from "../../../../primitives/index.js";
import type { SessionStore } from "../../../../store/index.js";
import { SettingsConfirmation } from "../../../shared/SettingsConfirmation.js";
import { InterruptedRunsNote } from "./InterruptedRunsNote.js";

/**
 * The restart, and what it costs, stated before it happens.
 *
 * `update.requestRestart()` quits this shell and relaunches it, which ends every run
 * on this node mid-turn. Until this component the button dispatched that straight
 * from a press, so the most destructive act the settings surface offers was also its
 * only unconfirmed one — and the two facts a person needs to decide were on screen
 * nowhere: which work stops, and how long the daemon is given to put it down.
 *
 * THE SENTENCE NAMES WHAT THE CONSOLE CANNOT SEE. The tally is scoped to the one
 * session this window has open, because that is the only run set the renderer holds —
 * there is no node-wide run census a settings page may read, and deriving one would
 * be the renderer answering a question the daemon owns. A count that quietly stood in
 * for the whole node would be worse than no count: it would read as complete. So the
 * dialog says which runs it CAN name and then says, in the same breath, that runs it
 * cannot see stop too.
 *
 * THE BUDGET IS QUOTED, NOT DECIDED. `DAEMON_SHUTDOWN_FLUSH_BUDGET_MS` is the main
 * process's own shutdown budget; this sentence reads it so the figure on screen and
 * the figure the shell waits cannot drift, and it renders as a DERIVED figure because
 * it is a bound this application chose rather than a value the daemon sent.
 */
export function RestartConfirmation(props: {
  /** The retained session's store, or `undefined` where this window has none open. */
  readonly sessionStore: SessionStore | undefined;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const { sessionStore } = props;
  return (
    <SettingsConfirmation
      triggerLabel="Restart to apply"
      triggerAriaLabel="Restart to apply the downloaded update"
      tone="primary"
      isDisabled={false}
      title="Restart to install the update?"
      description={
        <>
          {"Restarting quits this application and starts it again. "}
          {sessionStore === undefined ? (
            <span>This window has no session open, so it cannot name the runs that stop.</span>
          ) : (
            <InterruptedRunsNote sessionStore={sessionStore} />
          )}
          {" Runs in sessions this window does not have open are interrupted too. The daemon is " +
            "given up to "}
          <DerivedFigure text={formatDuration(DAEMON_SHUTDOWN_FLUSH_BUDGET_MS)} />
          {" to finish writing before it is stopped."}
        </>
      }
      keepLabel="Not now"
      confirmLabel="Restart"
      onConfirm={props.onConfirm}
    />
  );
}
