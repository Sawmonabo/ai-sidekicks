// The Runtime page: the supervisor's detail, one click behind the frame's chip.
//
// The frame shows the daemon's state as a chip; this page shows its detail (the attempt count
// and the last heartbeat), diagnostic only and never editable. Starting a stopped runtime is
// a main-process spawn, not a call, so that control lives in the app frame
// (`layout/AppShell/hooks/useDaemonStartAction.ts`), beside the state that makes it right.
//
// The page draws the supervisor's facts from its context. `DaemonOperationsBlocks`, passed
// as `children`, calls the daemon: its own reported status line, and the stop and restart
// controls. The two readings answer different questions and render apart, but a dispatched
// control and a supervisor transition both make the status line old, so the blocks re-put it
// on either. Nothing polls.
//
// Every control confirms, and the confirmation names what it will interrupt: stopping ends
// every run on this machine, and a person who reads only the verb has not been told that. A
// confirmation is one intended act, so once answered both actions are refused until the
// dispatch settles, or a double-click on a destructive verb would send two. The handler's
// tick decides the refusal (`hooks/useDaemonControl.ts`); this file says so on screen.
//
// The blocks derive no eligibility: no field reports whether an operation would be
// permitted, so graying one out would invent the answer. Disabling both confirmation actions
// while a dispatch is outstanding is not that, since the outstanding dispatch is a fact they
// hold.

import { useCallback, useState, type ReactNode } from "react";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { MainProcessState } from "@shared/daemon-status-topic.js";
import {
  UNREPORTED_DAEMON_NOTICE,
  describeDaemonConnection,
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
 * A sentence, never a bare disable: a control grayed out with no cause reads as broken.
 * Cancel is disabled too because nothing behind the bridge is cancelable, and a Cancel
 * offered after the call went out would read as retracting it. Both actions leave together
 * when the settlement clears the confirmation.
 */
const DISPATCHED_REASON =
  "Sent. It cannot be taken back, so both actions wait until the runtime answers.";

/** What each control does and the question its confirm asks. Written once. */
const CONTROL_COPY: Readonly<
  Record<DaemonControl, { readonly verb: string; readonly confirmation: string }>
> = {
  stop: {
    verb: "Stop",
    confirmation:
      "Stop the background service? Work in flight stops, and nothing new starts until it is running again.",
  },
  restart: {
    verb: "Restart",
    confirmation: "Restart the background service? Work in flight stops.",
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
  // Read after the controls: their settlements are one of the two facts that stale the
  // answer (see `hooks/useDaemonStatus.ts`).
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
        <h3 className="meridian-settings-page__block-title">Restart or stop it</h3>
        <p className="meridian-settings-page__aside">
          Both stop whatever is in flight on this machine.
        </p>
        {confirming === undefined ? (
          <div className="meridian-settings-page__actions">
            <button
              type="button"
              className="meridian-settings-page__action meridian-action-button"
              onClick={() => {
                setConfirming("stop");
              }}
            >
              {CONTROL_COPY.stop.verb}
            </button>
            <button
              type="button"
              className="meridian-settings-page__action meridian-action-button"
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
 * The attempt count appears only on the two arms that have one, which is why the connection
 * is a union.
 */
function renderSupervisorFacts(state: MainProcessState): ReactNode {
  const { connection, lastHeartbeatAt, negotiation } = state;
  return (
    <>
      {renderFact(
        "State",
        connection.kind === "unreported" ? (
          <Nothing kind="not-checked" placement="inline" title={UNREPORTED_DAEMON_NOTICE.title} />
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
            <WireFigure value={negotiation.appProtocolVersion} /> here,{" "}
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
          placement="block"
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
 * The confirm step: the question, the verb, and the two ways out of it.
 *
 * `dispatchedReason` is `undefined` while the confirmation is a question and a sentence once
 * it has been answered, so one value carries both the disable and its cause.
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
      <p>{copy.confirmation}</p>
      <div className="meridian-settings-page__actions">
        <button
          type="button"
          className="meridian-settings-page__action meridian-settings-page__action--primary meridian-action-button"
          disabled={isDispatched}
          title={dispatchedReason}
          onClick={onConfirm}
        >
          {copy.verb}
        </button>
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
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
 * "Sent", never "stopped": the call answers that the runtime accepted the request, and the
 * supervisor's own report says what happened to it.
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
