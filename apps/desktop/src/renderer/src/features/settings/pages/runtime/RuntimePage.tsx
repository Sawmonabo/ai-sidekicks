// The Runtime page: the supervisor's detail, one click behind the frame's chip.
//
// The daemon's state belongs in the frame as a chip, with its DETAIL (the attempt count
// and the last heartbeat) one click away, diagnostic only and never editable. This is
// that click. Starting a stopped runtime is a main-process spawn rather than a call, and that
// control lives on the frame's own offline banner, beside the state that makes it the
// right thing to press.
//
// The page draws the supervisor's facts, which arrive on its context. What calls the
// daemon is `DaemonOperationsBlocks`, passed to the page as `children`: the daemon's own
// reported status line, and two controls, stop and restart, which are calls to a runtime
// that is running. The two readings answer different questions and are rendered apart,
// but a stop the blocks dispatched and a supervisor transition they merely watched both
// make the status line old, so the state on the context is half of what says when to put
// it again. Nothing here polls to find that out.
//
// EVERY CONTROL CONFIRMS, and the confirmation names what it will interrupt rather than
// asking "are you sure": stopping the runtime ends every run on this machine, and a
// person who reads only the verb has not been told that.
//
// AND IT CONFIRMS ONCE. A confirmation is the record of one intended act, so once it has
// been answered both of its actions are refused until the dispatch settles; otherwise a
// double-click on a destructive verb sends two of them. The refusal itself is decided in
// the handler's own tick by `hooks/useDaemonControl.ts`; what this file owns is saying so on
// screen rather than leaving a control that quietly does nothing.
//
// THE BLOCKS DERIVE NO ELIGIBILITY. They offer both controls in every state: no field
// reports whether an operation would be permitted, so a page that grayed one out would be
// inventing the answer. Disabling both confirmation actions
// while a dispatch is outstanding is not that: whether the blocks have a dispatch
// outstanding is a fact they hold rather than a permission they guessed.

import { useCallback, useState, type ReactNode } from "react";

import { Chip, Nothing, WireFigure } from "@renderer/console/primitives/index.js";
import {
  UNREPORTED_DAEMON_NOTICE,
  describeDaemonConnection,
  type MainProcessState,
} from "@renderer/store/window/main-process-state.js";
import type { SettingsPageContext } from "../../types.js";
import {
  useDaemonStatus,
  type DaemonOperations,
  type DaemonStatusReading,
} from "./hooks/useDaemonStatus.js";
import {
  useDaemonControl,
  type DaemonControl,
  type DaemonControlSettlement,
} from "./hooks/useDaemonControl.js";
import { MountedFoldersBlock } from "./mounted-folders/MountedFoldersBlock.js";

/**
 * Why both confirmation actions are refused once one dispatch has gone out.
 *
 * A SENTENCE AND NEVER A BARE DISABLE, on the rule the join form states: a control
 * grayed out with no cause reads as broken. Cancel is disabled beside the primary
 * rather than left live, because nothing behind the bridge is cancelable — a Cancel
 * offered after the call went out would read as retracting it, and it retracts
 * nothing. Both actions leave together when the settlement clears the confirmation.
 */
const DISPATCHED_REASON =
  "Sent. It cannot be taken back, so both actions wait until the runtime answers.";

/** What each control does and what a person is agreeing to. Written once. */
const CONTROL_COPY: Readonly<
  Record<DaemonControl, { readonly verb: string; readonly consequence: string }>
> = {
  stop: {
    verb: "Stop",
    consequence:
      "Work in flight on this machine stops. Nothing new can be started until the background service is running again, and starting it is a shell action rather than a control on this page.",
  },
  restart: {
    verb: "Restart",
    consequence:
      "Work in flight on this machine stops. The background service is given ten seconds to flush before it goes down, and this window reconnects on its own once it is back.",
  },
};

/** What the Runtime page is handed. */
export interface RuntimePageProps {
  readonly context: SettingsPageContext;
  /** What sits under the supervisor's facts: the blocks that call the daemon. */
  readonly children?: ReactNode;
}

/** What the blocks that call the daemon are handed. */
export interface DaemonOperationsBlocksProps {
  readonly context: SettingsPageContext;
  /** Held stable by the caller: a new object restarts the status read. */
  readonly operations: DaemonOperations;
}

/** The page: the lede, what the supervisor reports about the runtime, and its folders. */
export function RuntimePage(props: RuntimePageProps): ReactNode {
  return (
    <section className="meridian-settings-page" aria-label="Runtime">
      <p className="meridian-settings-page__lede">
        What the main process knows about the runtime on this machine. Everything below is read from
        the supervisor and is not editable here.
      </p>

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Supervisor</h3>
        <dl className="meridian-settings-page__facts">
          {renderSupervisorFacts(props.context.mainProcessState)}
        </dl>
      </section>

      {props.children}

      <MountedFoldersBlock />
    </section>
  );
}

/** The two blocks that call the daemon: its own reported status, and stop and restart. */
export function DaemonOperationsBlocks(props: DaemonOperationsBlocksProps): ReactNode {
  const { mainProcessState } = props.context;
  const [confirming, setConfirming] = useState<DaemonControl | undefined>(undefined);
  const [settlement, setSettlement] = useState<DaemonControlSettlement | undefined>(undefined);
  const onSettled = useCallback((next: DaemonControlSettlement) => {
    setSettlement(next);
    setConfirming(undefined);
  }, []);
  const control = useDaemonControl(props.context.bridge, props.operations, onSettled);
  // Read AFTER the controls, because what stales its answer is partly theirs. This
  // supplies the two facts `hooks/useDaemonStatus.ts` names: the supervisor's reported state,
  // and the settlements this page's own dispatches produced.
  const status = useDaemonStatus(
    props.context.bridge,
    { connection: mainProcessState.connection, settledControlCount: control.settledCount },
    props.operations,
  );

  return (
    <>
      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Reported status</h3>
        {renderStatusRegion(status)}
      </section>

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Controls</h3>
        {confirming === undefined ? (
          <div className="meridian-settings-page__actions">
            <button
              type="button"
              className="meridian-settings-page__action"
              onClick={() => {
                setConfirming("stop");
              }}
            >
              {CONTROL_COPY.stop.verb}
            </button>
            <button
              type="button"
              className="meridian-settings-page__action"
              onClick={() => {
                setConfirming("restart");
              }}
            >
              {CONTROL_COPY.restart.verb}
            </button>
          </div>
        ) : (
          renderControlConfirm(
            confirming,
            control.inFlight === undefined ? undefined : DISPATCHED_REASON,
            () => {
              void control.put(confirming);
            },
            () => {
              setConfirming(undefined);
            },
          )
        )}
        {renderControlSettlement(settlement)}
      </section>
    </>
  );
}

/**
 * The supervisor's own numbers.
 *
 * The attempt count appears only on the two arms that HAVE one, which is the whole
 * reason the connection is a union: a row reading "attempt — of 5" on a connected
 * window would be a field with nothing in it pretending to be a measurement.
 */
function renderSupervisorFacts(state: MainProcessState): ReactNode {
  const { connection, lastHeartbeatAt, negotiation } = state;
  return (
    <>
      {renderFact(
        "State",
        connection.kind === "unreported" ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title={UNREPORTED_DAEMON_NOTICE.title}
            detail={UNREPORTED_DAEMON_NOTICE.detail}
          />
        ) : (
          <span>{describeDaemonConnection(connection)}</span>
        ),
      )}
      {connection.kind === "reconnecting"
        ? renderFact(
            "Attempt",
            <span>
              {connection.attempt} of {connection.attemptLimit}
            </span>,
          )
        : null}
      {connection.kind === "offline"
        ? renderFact(
            "Attempts spent",
            <span>
              {connection.attemptLimit} of {connection.attemptLimit}
            </span>,
          )
        : null}
      {connection.kind === "offline"
        ? renderFact(
            "Last error",
            connection.lastError === undefined ? (
              <Nothing
                kind="not-checked"
                placement="inline"
                title="No error recorded"
                detail="The supervisor reported that it gave up without saying why."
              />
            ) : (
              <WireFigure value={connection.lastError} />
            ),
          )
        : null}
      {renderFact(
        "Last heartbeat",
        lastHeartbeatAt === undefined ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="No heartbeat reported"
            detail="This window has not been told when the supervisor last heard from the runtime."
          />
        ) : (
          <WireFigure value={lastHeartbeatAt} />
        ),
      )}
      {renderFact(
        "Protocol",
        negotiation === undefined ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="No handshake reported"
            detail="This window has not been told what the runtime and the console agreed on."
          />
        ) : (
          <span>
            <WireFigure value={negotiation.consoleProtocolVersion} /> here,{" "}
            <WireFigure value={negotiation.daemonProtocolVersion} /> there
          </span>
        ),
      )}
    </>
  );
}

/** One row of the facts grid. `dt` is the console's word, `dd` the wire's value. */
function renderFact(term: string, value: ReactNode): ReactNode {
  return (
    <div className="meridian-settings-page__fact" key={term}>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The daemon's own status line, on whichever of the read's two phases applies. */
function renderStatusRegion(reading: DaemonStatusReading): ReactNode {
  switch (reading.phase) {
    case "reading":
      return (
        <Nothing
          kind="computing"
          placement="surface"
          title="Asking the runtime"
          detail="The status the background service reports about itself, which is a different question from what the supervisor observed."
        />
      );
    case "read":
      return (
        <dl className="meridian-settings-page__facts">
          {renderFact("Reported state", <WireFigure value={reading.status.state} />)}
          {renderFact("Version", <WireFigure value={reading.status.version} />)}
        </dl>
      );
  }
}

/**
 * The confirm step: the verb, what it costs, and the two ways out of it.
 *
 * `dispatchedReason` is `undefined` while the confirmation is still a question and a
 * sentence once it has been answered — one value carrying both the disable and its
 * cause, so no arm of this markup can offer a control it cannot explain.
 */
function renderControlConfirm(
  control: DaemonControl,
  dispatchedReason: string | undefined,
  onConfirm: () => void,
  onCancel: () => void,
): ReactNode {
  const copy = CONTROL_COPY[control];
  const isDispatched = dispatchedReason !== undefined;
  return (
    <div className="meridian-settings-page__state">
      <p>{copy.consequence}</p>
      <div className="meridian-settings-page__actions">
        <button
          type="button"
          className="meridian-settings-page__action meridian-settings-page__action--primary"
          disabled={isDispatched}
          title={dispatchedReason}
          onClick={onConfirm}
        >
          {copy.verb}
        </button>
        <button
          type="button"
          className="meridian-settings-page__action"
          disabled={isDispatched}
          title={dispatchedReason}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {isDispatched ? <p>{dispatchedReason}</p> : null}
    </div>
  );
}

/**
 * What came back from the last control.
 *
 * "Sent" and never "stopped": the call answers that the runtime accepted the request,
 * and the supervisor's own report above is what says what happened to it.
 */
function renderControlSettlement(settlement: DaemonControlSettlement | undefined): ReactNode {
  if (settlement === undefined) {
    return null;
  }
  return (
    <p className="meridian-settings-page__state">
      <Chip label={CONTROL_COPY[settlement.control].verb} /> sent. The supervisor's state above is
      what says what happened to it.
    </p>
  );
}
