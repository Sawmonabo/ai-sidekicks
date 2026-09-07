// The local-runtime page: the supervisor's detail, one click behind the frame's chip.
//
// `Spec-023 §Console Design (Meridian)` puts the daemon's state in the frame as a
// chip and its DETAIL — the attempt count and the last heartbeat — one click away,
// diagnostic only and never editable. This is that click. The tray carrying the same
// three states outside the window is main-process work on a later phase
// (`T-023r-3-x`); nothing here reaches for it.
//
// TWO CONTROLS AND NO THIRD. Stop and restart are calls to a runtime that is running.
// Starting a stopped one is a shell spawn rather than a call — a stopped daemon has
// no server to receive one — and that control lives on the frame's own offline
// banner, beside the state that makes it the right thing to press.
//
// EVERY CONTROL CONFIRMS, and the confirmation names what it will interrupt rather
// than asking "are you sure": stopping the runtime ends every run on this machine,
// and a person who reads only the verb has not been told that.
//
// AND IT CONFIRMS ONCE. A confirmation is the record of one intended act, so once it
// has been answered both of its actions are refused until the dispatch settles —
// otherwise a double-click on a destructive verb sends two of them. The refusal
// itself is decided in the handler's own tick by `daemon-controls.ts`; what this file
// owns is saying so on screen rather than leaving a control that quietly does nothing.
//
// THE PAGE DERIVES NO ELIGIBILITY. It offers both controls in every state and lets
// the refusal render, which is the same discipline the operator surfaces are held to:
// no field reports whether an operation would be permitted, so a page that greyed one
// out would be inventing the answer. The disable above is not that: whether THIS page
// has a dispatch outstanding is a fact it holds rather than a permission it guessed.

import { useCallback, useState, type ReactNode } from "react";

import { Chip, InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import {
  UNREPORTED_SHELL_NOTICE,
  describeShellConnection,
  type ShellState,
} from "../../../store/index.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";
import {
  useDaemonControl,
  useDaemonStatus,
  type DaemonControl,
  type DaemonControlSettlement,
  type DaemonStatusReading,
} from "./daemon-controls.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-daemon";

/**
 * Why both confirmation actions are refused once one dispatch has gone out.
 *
 * A SENTENCE AND NEVER A BARE DISABLE, on the rule the join form states: a control
 * greyed out with no cause reads as broken. Cancel is disabled beside the primary
 * rather than left live, because nothing behind the bridge is cancellable — a Cancel
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
    verb: "Stop the local runtime",
    consequence:
      "Every run on this machine ends. Nothing new can be started until the runtime is running again, and starting it is a shell action rather than a control on this page.",
  },
  restart: {
    verb: "Restart the local runtime",
    consequence:
      "Every run on this machine is interrupted. The runtime is given ten seconds to flush before it goes down, and this window reconnects on its own once it is back.",
  },
};

export interface DaemonPageProps {
  readonly context: SettingsPageContext;
}

export function DaemonPage(props: DaemonPageProps): ReactNode {
  const { shellState } = props.context;
  const status = useDaemonStatus(props.context.bridge.growth);
  const [confirming, setConfirming] = useState<DaemonControl | undefined>(undefined);
  const [settlement, setSettlement] = useState<DaemonControlSettlement | undefined>(undefined);
  const onSettled = useCallback((next: DaemonControlSettlement) => {
    setSettlement(next);
    setConfirming(undefined);
  }, []);
  const control = useDaemonControl(props.context.bridge.growth, onSettled);

  return (
    <section className="meridian-settings-page" aria-label="Local runtime">
      <p className="meridian-settings-page__lede">
        What the shell knows about the runtime on this machine. Everything below is read from the
        supervisor and is not editable here.
      </p>

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__block-title">Supervisor</h3>
        <dl className="meridian-settings-page__facts">{renderSupervisorFacts(shellState)}</dl>
      </section>

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
              control.put(confirming);
            },
            () => {
              setConfirming(undefined);
            },
          )
        )}
        {renderControlSettlement(settlement)}
      </section>
    </section>
  );
}

/**
 * The supervisor's own numbers.
 *
 * The attempt count appears only on the two arms that HAVE one, which is the whole
 * reason the connection is a union: a row reading "attempt — of 5" on a connected
 * window would be a field with nothing in it pretending to be a measurement.
 */
function renderSupervisorFacts(state: ShellState): ReactNode {
  const { connection, lastHeartbeatAt, negotiation } = state;
  return (
    <>
      {renderFact(
        "State",
        connection.kind === "unreported" ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title={UNREPORTED_SHELL_NOTICE.title}
            detail={UNREPORTED_SHELL_NOTICE.detail}
          />
        ) : (
          <span>{describeShellConnection(connection)}</span>
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

/** The daemon's own status line, on whichever of the read's three phases applies. */
function renderStatusRegion(reading: DaemonStatusReading): ReactNode {
  switch (reading.phase) {
    case "reading":
      return (
        <Nothing
          kind="computing"
          placement="surface"
          title="Asking the runtime"
          detail="The status the daemon reports about itself, which is a different question from what the supervisor observed."
        />
      );
    case "refused":
      return <InlineRefusal {...reading.refusal} />;
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
  if (settlement.outcome === "refused") {
    return <InlineRefusal {...settlement.refusal} />;
  }
  return (
    <p className="meridian-settings-page__state">
      <Chip label={CONTROL_COPY[settlement.control].verb} /> sent. The supervisor's state above is
      what says what happened to it.
    </p>
  );
}

/** Claim the local-runtime section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerDaemonPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "daemon",
    owner: OWNER,
    label: "Local runtime",
    keywords: ["daemon", "supervisor", "runtime", "restart", "stop", "heartbeat", "connection"],
    render: (context) => <DaemonPage context={context} />,
  });
}
