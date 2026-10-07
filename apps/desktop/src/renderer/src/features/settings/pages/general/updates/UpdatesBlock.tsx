// Where the update stands, and who decides when it lands.
//
// The read-out renders exactly the members of the `UpdateState` union on the preload contract.
// Nothing downloads or restarts without a press: the download control exists only on the
// `available` arm and the restart control only on `ready`, the updater's word that the
// download completed. The console never derives readiness from a percent, and only
// `downloading` carries one and renders a bar. A control whose call fails draws a fixed sentence
// for that control under the controls, which stay drawn. Under the read-out sits the switch for
// the machine setting `updatesAutomatic`, drawn only once the settings file has been read so it
// never shows a value it does not hold: a refused write leaves the switch where it was and draws
// the refusal's message, or the screen's fixed sentence for it, in the strip, with `Try again`
// sending the same change again.

import { useEffect, useState, type ReactNode } from "react";
import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts/machine-settings";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import type { Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { PreferenceToggleRow } from "#renderer/features/settings/components/PreferenceToggleRow.js";
import type { MachineSettingsBinding } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import { UPDATE_STATE_WORDS, type UpdaterCalls, type UpdateReading } from "./updater-reading.js";
import { useUpdateReading } from "../hooks/useUpdateReading.js";
import { UpdateReadOut } from "./UpdateReadOut.js";
import { UPDATER_UNREACHABLE_DETAIL } from "./updater-unreachable.js";

/** The subsystem a refused updater control names as its author. */
const UPDATER_CONTROL_ORIGIN = "updater-control";

/** The code a rejected updater control is reported under. */
const UPDATER_CONTROL_FAILED = "updater-control-failed";

/** What the update block is handed. */
export interface UpdatesBlockProps {
  readonly updater: UpdaterCalls;
  /** The machine settings the automatic-check switch reads and writes. */
  readonly preferences: Pick<
    MachineSettingsBinding,
    "snapshot" | "settings" | "isPending" | "refusalFor" | "choose" | "retry" | "readAgain"
  >;
}

/** The updater's state, the controls that ask it to move, and the automatic-check switch. */
export function UpdatesBlock(props: UpdatesBlockProps): ReactNode {
  const { updater, preferences } = props;
  const reading = useUpdateReading(updater);
  const clock = useClock();
  // The state the first read lands on stands; a later change of state is said.
  useAnnounceWhenChanged(updateSettlementSentence(reading), "polite", { isReadSettlement: true });
  const status = reading.kind === "state" ? reading.state.status : undefined;
  const failureMessage =
    reading.kind === "state" && reading.state.status === "error"
      ? reading.state.message
      : undefined;
  // The updater's own words are for the log; the screen draws the fixed sentence.
  useEffect(() => {
    if (failureMessage === undefined) {
      return;
    }
    windowDiagnosticCapture.record({
      at: diagnosticStampAt(clock),
      severity: "error",
      source: "features/settings",
      kind: "update-failed",
      detail: failureMessage,
    });
  }, [failureMessage, clock]);
  const [controlRefusal, setControlRefusal] = useState<Refusal | undefined>(undefined);
  // A read's `Try again` clears the refusal and reopens in one act, so a reopen that throws at once
  // leaves the same line drawn; the press count says it again. The feed's own reopens after a
  // wait do not count, so they are not read out one by one.
  const [readAgainCount, setReadAgainCount] = useState(0);
  const readAgain = (): void => {
    setReadAgainCount((count) => count + 1);
    preferences.readAgain();
  };
  const press = (request: () => Promise<void>, failedDetail: string): void => {
    setControlRefusal(undefined);
    request().catch(() => {
      setControlRefusal(refuse(UPDATER_CONTROL_ORIGIN, UPDATER_CONTROL_FAILED, failedDetail));
    });
  };

  return (
    <section className="meridian-settings-page__block" aria-label="Application updates">
      <h3 className="meridian-settings-page__section-head">Updates</h3>

      <UpdateReadOut
        reading={reading}
        clock={clock}
        onTryAgain={() => {
          press(() => updater.requestCheck(), UPDATER_UNREACHABLE_DETAIL.check);
        }}
      />

      <div className="meridian-settings-page__actions">
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={() => {
            press(() => updater.requestCheck(), UPDATER_UNREACHABLE_DETAIL.check);
          }}
        >
          Check now
        </button>
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
            aria-label="Restart to apply the downloaded update"
            onClick={() => {
              press(() => updater.requestRestart(), UPDATER_UNREACHABLE_DETAIL.restart);
            }}
          >
            Restart to apply
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

      {renderAutomaticCheck(preferences, clock, { readAgain, readAgainCount })}
    </section>
  );
}

/**
 * The automatic-check switch once the settings file has been read; before that, the reading line
 * after the short delay, or the failed read with `Try again`.
 */
function renderAutomaticCheck(
  preferences: UpdatesBlockProps["preferences"],
  clock: Clock,
  readAgainPress: { readonly readAgain: () => void; readonly readAgainCount: number },
): ReactNode {
  const { reading, readRefusal } = preferences.snapshot;
  if (reading === undefined) {
    return readRefusal === undefined ? (
      <LoadingNotice clock={clock} placement="inline" title="Reading settings…" />
    ) : (
      <InlineRefusal
        code={readRefusal.code}
        detail="The settings could not be read."
        onTryAgain={readAgainPress.readAgain}
        attempt={readAgainPress.readAgainCount}
      />
    );
  }
  const preferenceRefusal = preferences.refusalFor("updatesAutomatic");
  return (
    <>
      <PreferenceToggleRow
        label="Check for updates automatically"
        checked={preferences.settings.updatesAutomatic}
        checkedByDefault={MACHINE_SETTINGS_DEFAULTS.updatesAutomatic}
        isPending={preferences.isPending("updatesAutomatic")}
        onCheckedChange={(checked) => {
          preferences.choose("updatesAutomatic", checked);
        }}
      />
      {preferenceRefusal === undefined ? null : (
        <InlineRefusal
          code={preferenceRefusal.code}
          detail={preferenceRefusal.detail}
          onTryAgain={() => {
            preferences.retry("updatesAutomatic");
          }}
        />
      )}
    </>
  );
}

/**
 * The one sentence this block announces, the settled state's drawn words, or `undefined` while no
 * state has settled; a refused read and the updater's failure are drawn as lines that speak for
 * themselves, so the sentence settles on `null` there. It carries no figure: `downloading`
 * re-settles on every push, and a sentence with the percent would be announced once per
 * percentage point.
 */
function updateSettlementSentence(reading: UpdateReading): string | null | undefined {
  if (reading.kind === "not-read") {
    return undefined;
  }
  if (reading.kind === "failed" || reading.state.status === "error") {
    return null;
  }
  return UPDATE_STATE_WORDS[reading.state.status];
}
