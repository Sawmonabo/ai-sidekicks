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

import { Button } from "@base-ui/react/button";
import { useCallback, useState, type ReactNode } from "react";

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { Clock } from "#renderer/lib/clock.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import {
  formatByteQuantity,
  formatClockTime,
  formatPercent,
  formatZonedDateTime,
} from "#renderer/lib/wire/figures.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { SettingsFact } from "../../components/SettingsFact.js";
import type { SettingsPageContext } from "../../types.js";
import type { DaemonOperations, DaemonStatusReading } from "./daemon-status-read.js";
import { useDaemonStatus } from "./hooks/useDaemonStatus.js";
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
      "Stop the background service? Work in flight stops, and nothing " +
      "new starts until it is running again.",
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
  const clock = useClock();
  const clockLocale = useClockLocale();
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
        <h3 className="meridian-settings-page__section-head">Reported status</h3>
        {renderStatusRegion(status.reading, status.checkAgain, clock, clockLocale)}
      </section>

      <section className="meridian-settings-page__block">
        <h3 className="meridian-settings-page__section-head">Restart or stop it</h3>
        <p className="meridian-settings-page__aside">Both stop whatever is in flight.</p>
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

/**
 * The daemon's own status line, on whichever of the read's three phases applies, with
 * `Check again` beside a settled reading, each reading's time written in `clockLocale`. The first
 * read's line waits out the short delay on `clock`, so an answer that comes at once draws no flash
 * of words.
 */
function renderStatusRegion(
  reading: DaemonStatusReading,
  checkAgain: () => void,
  clock: Clock,
  clockLocale: string,
): ReactNode {
  switch (reading.phase) {
    case "reading":
      return (
        <LoadingNotice clock={clock} placement="block" title="Reading the background service…" />
      );
    case "read":
      return (
        <>
          <dl className="meridian-settings-page__facts">
            <SettingsFact term="Reported state">
              {codeWords(reading.status.processState)}
            </SettingsFact>
            <SettingsFact term="Version">
              <WireFigure value={reading.status.version} />
            </SettingsFact>
            <SettingsFact term="Processor">
              {renderUsageReading(
                reading.status.processor === null
                  ? undefined
                  : {
                      figure: formatPercent(reading.status.processor.percent / 100),
                      exactValue: String(reading.status.processor.percent),
                      readAt: reading.status.processor.readAt,
                    },
                clockLocale,
              )}
            </SettingsFact>
            <SettingsFact term="Memory">
              {renderUsageReading(
                reading.status.memory === null
                  ? undefined
                  : {
                      figure: formatByteQuantity(reading.status.memory.residentBytes).text,
                      exactValue: String(reading.status.memory.residentBytes),
                      readAt: reading.status.memory.readAt,
                    },
                clockLocale,
              )}
            </SettingsFact>
          </dl>
          <TryAgainButton word="Check again" onPress={checkAgain} />
        </>
      );
    case "failed":
      return (
        <InlineRefusal
          code={reading.refusal.code}
          detail={NOT_ANSWERING_MESSAGE}
          onTryAgain={checkAgain}
          attempt={reading.refusal}
        />
      );
  }
}

/**
 * One reading of what the service uses, stamped with when it was taken; none reads as not read.
 * The figure's hover label carries the exact value the service sent, and the time's carries the
 * zoned time on the machine's clock.
 */
function renderUsageReading(
  reading:
    | { readonly figure: string; readonly exactValue: string; readonly readAt: string }
    | undefined,
  clockLocale: string,
): ReactNode {
  if (reading === undefined) {
    return <span>Not read yet</span>;
  }
  return (
    <span>
      <WireFigure value={reading.figure} hoverLabel={reading.exactValue} /> · as of{" "}
      <WireFigure
        value={formatClockTime(reading.readAt, clockLocale)}
        hoverLabel={formatZonedDateTime(reading.readAt, clockLocale)}
      />
    </span>
  );
}

/**
 * The confirm step: the question, the verb, and the two ways out of it.
 *
 * `dispatchedReason` is `undefined` while the confirmation is a question and a sentence once
 * it has been answered, so one value carries both the disable and its cause. A disabled button
 * keeps focus, so the press that answers does not drop focus to the page.
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
      {/* The question appears on the press, holding its words, so it says them. */}
      <AnnouncedLine element="p" words={copy.confirmation} politeness="polite" />
      <div className="meridian-settings-page__actions">
        <HoverLabel text={dispatchedReason} textIs="description">
          <Button
            className={
              "meridian-settings-page__action " +
              "meridian-settings-page__action--destructive meridian-action-button"
            }
            disabled={isDispatched}
            focusableWhenDisabled
            onClick={onConfirm}
          >
            {copy.verb}
          </Button>
        </HoverLabel>
        <HoverLabel text={dispatchedReason} textIs="description">
          <Button
            className="meridian-settings-page__action meridian-action-button"
            disabled={isDispatched}
            focusableWhenDisabled
            onClick={onCancel}
          >
            Cancel
          </Button>
        </HoverLabel>
      </div>
      {isDispatched ? (
        <AnnouncedLine element="p" words={dispatchedReason} politeness="polite" />
      ) : null}
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
  const verb = CONTROL_COPY[settlement.control].verb;
  return (
    // A second press that settles the same way is a new settlement, said again.
    <AnnouncedLine
      element="p"
      className="meridian-settings-page__state"
      words={`${verb} sent. ${SUPERVISOR_STATE_NOTE}`}
      politeness="polite"
      attempt={settlement}
    >
      <Chip label={verb} /> sent. {SUPERVISOR_STATE_NOTE}
    </AnnouncedLine>
  );
}

/** What a sent control's line says after the control's name. */
const SUPERVISOR_STATE_NOTE = "The supervisor's state above is what says what happened to it.";
