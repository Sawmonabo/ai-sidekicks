// Where the update stands, and who decides when it lands.
//
// The read-out renders exactly the members of the `UpdateState` union on the preload contract.
// Nothing downloads or restarts without a press: the download control exists only on the
// `available` arm and the restart control only on `ready`, the updater's word that the
// download completed. The console never derives readiness from a percent, and only
// `downloading` carries one and renders a bar. A control whose call fails draws a fixed sentence
// for that control under the controls, which stay drawn. Under the read-out sits the switch for
// the machine setting `updatesAutomatic`, drawn only once the settings file has been read so it never
// shows a value it does not hold: a refused write leaves the switch where it was and draws the
// service's words in the page's strip, with `Try again` sending the same change again.

import type { UpdateState } from "#shared/preload-api.js";
import { useState, type ReactNode } from "react";
import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts/machine-settings";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useSettlementAnnouncement } from "#renderer/hooks/announce/useSettlementAnnouncement.js";
import type { Clock } from "#renderer/lib/clock.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { PreferenceToggleRow } from "#renderer/features/settings/components/PreferenceToggleRow.js";
import type { MachineSettingsBinding } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import type { UpdaterCalls, UpdateReading } from "./updater-reading.js";
import { useUpdateReading } from "../hooks/useUpdateReading.js";
import { UpdateReadOut } from "./UpdateReadOut.js";
import { UPDATER_UNREACHABLE_DETAIL } from "./updater-unreachable.js";

/**
 * What each settled arm of the updater's read says, for the person who cannot see it.
 *
 * Total over `UpdateState`, so a new upstream arm is a compile error. It carries no percent:
 * `downloading` re-settles on every push and a sentence with the figure would be announced
 * once per percentage point.
 */
const UPDATE_STATUS_SETTLEMENTS: Readonly<Record<UpdateState["status"], string>> = {
  idle: "Update state read. No update is waiting.",
  checking: "Update state read. A check is running.",
  available: "Update state read. An update is available to download.",
  downloading: "Update state read. An update is downloading.",
  verifying: "Update state read. The update's signature is being checked.",
  ready: "Update state read. An update has downloaded and installs on the next restart.",
  error: "Update state read. The updater reported a failure.",
};

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
  // Said once, when the updater read lands.
  useSettlementAnnouncement(updateSettlementSentence(reading));
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
      <h3 className="meridian-settings-page__section-head">Updates</h3>

      <UpdateReadOut reading={reading} clock={clock} />

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
        <InlineRefusal code={controlRefusal.code} detail={controlRefusal.detail} />
      )}

      {renderAutomaticCheck(preferences, clock)}
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
): ReactNode {
  const { reading, readRefusal } = preferences.snapshot;
  if (reading === undefined) {
    return readRefusal === undefined ? (
      <LoadingNotice clock={clock} placement="inline" title="Reading settings…" />
    ) : (
      <InlineRefusal
        code={readRefusal.code}
        detail="The settings could not be read."
        onTryAgain={preferences.readAgain}
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
 * The one sentence this block announces, or `undefined` while no state has settled; a refused
 * read is drawn as a refusal, which speaks for itself.
 *
 * The `error` arm appends the updater's message so the announcement says what failed.
 */
function updateSettlementSentence(reading: UpdateReading): string | undefined {
  if (reading.kind !== "state") {
    return undefined;
  }
  return reading.state.status === "error"
    ? `${UPDATE_STATUS_SETTLEMENTS.error} ${reading.state.message}`
    : UPDATE_STATUS_SETTLEMENTS[reading.state.status];
}
