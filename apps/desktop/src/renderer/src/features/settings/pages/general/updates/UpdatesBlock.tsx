// Where the update stands, and who decides when it lands.
//
// The read-out renders exactly the members of the `UpdateState` union on the preload contract.
// Nothing downloads or restarts without a press: the check control exists only before an update
// is found, the download control only on the `available` arm and the restart control only on
// `ready`, the updater's word that the download completed; the restart asks nothing, since the
// service keeps every session, run and shell going through it. The console never derives
// readiness from a percent, and only `downloading` carries one and renders a bar. A failure the
// updater reports offers `Try again`, which does the failed step again. A control whose call
// fails draws a fixed sentence for that control under the controls, which stay drawn. Under the
// read-out sits the switch for the machine setting `updatesAutomatic`, whose row stands with its
// label from the first frame and shows the switch only once the settings file has been read; its
// `Loading…` reads the page's one loading delay.

import { useState, type ReactNode } from "react";
import type { UpdateFailedStep } from "#shared/preload-api.js";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { joinFigureSentence } from "#renderer/lib/figure-sentence.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { MachineSettingSwitchRow } from "#renderer/features/settings/components/MachineSettingSwitchRow.js";
import type { MachineSettingsBinding } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import type { UpdaterCalls, UpdateReading } from "#renderer/store/update/reading.js";
import { UPDATER_UNREACHABLE_DETAIL } from "#renderer/store/update/unreachable.js";
import { GENERAL_CONTROLS, UPDATES_HEADING } from "../controls.js";
import { RESTART_TO_FINISH, updateStateLine } from "./state-words.js";
import { UpdateReadOut } from "./UpdateReadOut.js";

/** The subsystem a refused updater control names as its author. */
const UPDATER_CONTROL_ORIGIN = "updater-control";

/** The code a rejected updater control is reported under. */
const UPDATER_CONTROL_FAILED = "updater-control-failed";

/** What the update block is handed. */
export interface UpdatesBlockProps {
  /** The window's one reading of the updater, which the read-out draws. */
  readonly reading: UpdateReading;
  /** The version this install runs, which the idle line names as the newest seen. */
  readonly runningVersion: string;
  /** Reads the updater's state again after a failed read. */
  readonly onReadAgain: () => void;
  /** The updater's controls the block's presses call. */
  readonly updater: UpdaterCalls;
  /** The machine settings the automatic-check switch reads and writes. */
  readonly preferences: Pick<
    MachineSettingsBinding,
    "snapshot" | "settings" | "isPending" | "refusalFor" | "choose" | "retry" | "readAgain"
  >;
  /** Whether the page's one loading delay has run out while the settings file is unread. */
  readonly isPastLoadingDelay: boolean;
}

/** The updater's state, the controls that ask it to move, and the automatic-check switch. */
export function UpdatesBlock(props: UpdatesBlockProps): ReactNode {
  const { reading, updater, preferences } = props;
  const clock = useClock();
  const clockLocale = useClockLocale();
  // The state the first read lands on stands; a later change of state is said.
  useAnnounceWhenChanged(
    updateSettlementSentence(reading, props.runningVersion, clockLocale),
    "polite",
    { isReadSettlement: true },
  );
  const status = reading.kind === "state" ? reading.state.status : undefined;
  const [controlRefusal, setControlRefusal] = useState<Refusal | undefined>(undefined);
  const press = (request: () => Promise<void>, failedDetail: string): void => {
    setControlRefusal(undefined);
    request().catch(() => {
      setControlRefusal(refuse(UPDATER_CONTROL_ORIGIN, UPDATER_CONTROL_FAILED, failedDetail));
    });
  };

  return (
    <section className="meridian-settings-page__block" aria-label="Application updates">
      <h3 className="meridian-settings-page__section-head">{UPDATES_HEADING}</h3>

      <UpdateReadOut
        reading={reading}
        runningVersion={props.runningVersion}
        clock={clock}
        onReadAgain={props.onReadAgain}
        onTryAgain={() => {
          if (reading.kind === "state" && reading.state.status === "error") {
            const { request, failedDetail } = stepAgain(updater, reading.state.step);
            press(request, failedDetail);
          }
        }}
      />

      <div className="meridian-settings-page__actions">
        {status === "idle" || status === "checking" ? (
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            // A check in flight is not asked for twice.
            disabled={status === "checking"}
            onClick={() => {
              press(() => updater.requestCheck(), UPDATER_UNREACHABLE_DETAIL.check);
            }}
          >
            Check for updates
          </button>
        ) : null}
        {status === "available" ? (
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            onClick={() => {
              press(() => updater.requestDownload(), UPDATER_UNREACHABLE_DETAIL.download);
            }}
          >
            Download
          </button>
        ) : null}
        {status === "ready" ? (
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            onClick={() => {
              press(() => updater.requestRestart(), UPDATER_UNREACHABLE_DETAIL.restart);
            }}
          >
            {RESTART_TO_FINISH}
          </button>
        ) : null}
      </div>
      {controlRefusal === undefined ? null : (
        <InlineRefusal
          code={controlRefusal.code}
          detail={controlRefusal.detail}
          attempt={controlRefusal}
        />
      )}

      <MachineSettingSwitchRow
        preferences={preferences}
        member="updatesAutomatic"
        control={GENERAL_CONTROLS.checkForUpdatesAutomatically}
        isPastLoadingDelay={props.isPastLoadingDelay}
      />
    </section>
  );
}

/** The call that does a failed step again, and the sentence drawn when main does not answer it. */
function stepAgain(
  updater: UpdaterCalls,
  step: UpdateFailedStep,
): { readonly request: () => Promise<void>; readonly failedDetail: string } {
  switch (step) {
    case "check":
      return {
        request: () => updater.requestCheck(),
        failedDetail: UPDATER_UNREACHABLE_DETAIL.check,
      };
    case "download":
    case "verify":
      return {
        request: () => updater.requestDownload(),
        failedDetail: UPDATER_UNREACHABLE_DETAIL.download,
      };
    case "restart":
      return {
        request: () => updater.requestRestart(),
        failedDetail: UPDATER_UNREACHABLE_DETAIL.restart,
      };
  }
}

/**
 * The one sentence this block announces, the settled state's drawn line, or `undefined` while no
 * state has settled; a refused read and the updater's failure are drawn as lines that speak for
 * themselves, so the sentence settles on `null` there.
 */
function updateSettlementSentence(
  reading: UpdateReading,
  runningVersion: string,
  clockLocale: string,
): string | null | undefined {
  if (reading.kind === "not-read") {
    return undefined;
  }
  if (reading.kind === "failed" || reading.state.status === "error") {
    return null;
  }
  return joinFigureSentence(updateStateLine(reading.state, runningVersion, clockLocale));
}
