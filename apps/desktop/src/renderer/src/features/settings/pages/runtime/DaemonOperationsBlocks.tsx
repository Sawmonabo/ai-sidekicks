// The Runtime page's blocks that call the daemon: its own reported status line, and the stop
// and restart controls.
//
// The two readings (the supervisor's, on the page, and the daemon's own, here) answer
// different questions and render apart, but a dispatched control and a supervisor transition
// both make the status line old, so the blocks re-put it on either. Nothing polls.
//
// Every control confirms, and the confirmation names what it will interrupt: stopping ends
// every run on this machine, and a person who reads only the verb has not been told that. A
// confirmation is one intended act, so once answered both actions are refused until the
// dispatch settles, or a double-click on a destructive verb would send two. The handler's
// tick decides the refusal (`hooks/useDaemonControl.ts`); this file says so on screen. A call
// the service refuses closes the confirmation and draws the service's own words under the
// controls, which stay drawn.
//
// The blocks derive no eligibility: no field reports whether an operation would be
// permitted, so graying one out would invent the answer. Disabling both confirmation actions
// while a dispatch is outstanding is not that, since the outstanding dispatch is a fact they
// hold.

import { useCallback, useState, type ReactNode } from "react";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import { SettingsFact } from "../../components/SettingsFact.js";
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

/** The subsystem a refused stop or restart names as its author. */
const DAEMON_CONTROL_ORIGIN = "daemon-control";

/** The code a rejected stop or restart that carried none of its own is reported under. */
const DAEMON_CONTROL_FAILED = "daemon-control-failed";

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

/** What the blocks that call the daemon are handed. */
export interface DaemonOperationsBlocksProps {
  readonly context: SettingsPageContext;
  /** Held stable by the caller: a new object restarts the status read. */
  readonly operations: DaemonOperations;
}

/** The two blocks that call the daemon: its own reported status, and stop and restart. */
export function DaemonOperationsBlocks(props: DaemonOperationsBlocksProps): ReactNode {
  const { mainProcessState } = props.context;
  const [confirming, setConfirming] = useState<DaemonControl | undefined>(undefined);
  const [settlement, setSettlement] = useState<DaemonControlSettlement | undefined>(undefined);
  const [controlRefusal, setControlRefusal] = useState<Refusal | undefined>(undefined);
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
  const askToConfirm = (pressed: DaemonControl): void => {
    setControlRefusal(undefined);
    setConfirming(pressed);
  };

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
                askToConfirm("stop");
              }}
            >
              {CONTROL_COPY.stop.verb}
            </button>
            <button
              type="button"
              className="meridian-settings-page__action meridian-action-button"
              onClick={() => {
                askToConfirm("restart");
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
              control.put(confirming).catch((error: unknown) => {
                setControlRefusal(
                  coerceToRefusal(error, DAEMON_CONTROL_ORIGIN, DAEMON_CONTROL_FAILED),
                );
                setConfirming(undefined);
              });
            },
            () => {
              setConfirming(undefined);
            },
          )
        )}
        {controlRefusal === undefined ? (
          renderControlSettlement(settlement)
        ) : (
          <InlineRefusal code={controlRefusal.code} detail={controlRefusal.detail} />
        )}
      </section>
    </>
  );
}

/** The daemon's own status line, on whichever of the read's three phases applies. */
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
          <SettingsFact term="Reported state">
            <WireFigure value={reading.status.processState} />
          </SettingsFact>
          <SettingsFact term="Version">
            <WireFigure value={reading.status.version} />
          </SettingsFact>
        </dl>
      );
    case "failed":
      return (
        <Nothing
          kind="error"
          placement="block"
          title="The background service is not answering."
          detail={reading.refusal.detail}
        />
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
