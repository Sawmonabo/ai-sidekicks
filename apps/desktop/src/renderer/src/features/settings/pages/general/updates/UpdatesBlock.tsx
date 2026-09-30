// Where the update stands, and who decides when it lands.
//
// The state read-out: `idle`, `checking`, `available` with the version found and its
// release, `downloading` with its percent, `verifying`, `ready`, and `error` with its
// message. `UpdateState` is a registered union on the preload contract and this file
// renders exactly its members.
//
// NOTHING DOWNLOADS OR RESTARTS WITHOUT A PRESS, AND `ready` MEANS DOWNLOADED
//
// The download control exists only on the `available` arm, the update the updater found
// and has not fetched. The restart control exists only on the `ready` arm, because that
// arm is what the updater says when the download has completed; the console never derives
// readiness from a percent, and it invents no percent for an arm that carries none — only
// `downloading` has one, and only `downloading` renders a bar.
//
// A call that throws or rejects is not caught here; it propagates to the caller.
//
// Under the read-out sits the switch for checking on its own, on by default. Its value is
// the machine setting `updatesAutomatic`.

import type { UpdateState } from "@shared/preload-api.js";
import type { ReactNode } from "react";

import { useSettlementAnnouncement } from "@renderer/hooks/useSettlementAnnouncement.js";
import { PreferenceToggleRow } from "../../../components/PreferenceToggleRow.js";
import type { MachineSettingsBinding } from "../../../machine-settings/hooks/useMachineSettings.js";
import type { UpdaterCalls, UpdateReading } from "./updater-reading.js";
import { useUpdateReading } from "../hooks/useUpdateReading.js";
import { UpdateReadOut } from "./UpdateReadOut.js";

/**
 * What each settled arm of the updater's read SAYS, for the person who cannot see it.
 *
 * TOTAL over `UpdateState`'s own union, so an arm landing upstream is a compile
 * error here rather than a settlement that lands silently.
 *
 * Deliberately carries no percent. The `downloading` arm re-settles on every push the
 * updater sends, and a sentence carrying the figure would be a different sentence each
 * time — which the announcer would dutifully say, once per percentage point, over the
 * top of everything else in the window. The bar on screen is where a moving number
 * belongs; the announcement is that the read landed and what it found.
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

/** What the update block is handed. */
export interface UpdatesBlockProps {
  readonly updater: UpdaterCalls;
  /** The machine settings the automatic-check switch reads and writes. */
  readonly preferences: Pick<MachineSettingsBinding, "settings" | "isPending" | "choose">;
}

/**
 * The update block: the updater's state, the controls that ask it to move, and the
 * switch for checking on its own.
 */
export function UpdatesBlock(props: UpdatesBlockProps): ReactNode {
  const { updater, preferences } = props;
  const reading = useUpdateReading(updater);
  // Said once, when the updater read lands.
  useSettlementAnnouncement(updateSettlementSentence(reading));
  const status = reading.kind === "state" ? reading.state.status : undefined;

  return (
    <section className="meridian-settings-page__block" aria-label="Application updates">
      <h3 className="meridian-settings-page__block-title">Updates</h3>

      <UpdateReadOut reading={reading} />

      <div className="meridian-settings-page__actions">
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={() => {
            void updater.requestCheck();
          }}
        >
          Check now
        </button>
        {status === "available" ? (
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            onClick={() => {
              void updater.requestDownload();
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
              void updater.requestRestart();
            }}
          >
            Restart to apply
          </button>
        ) : null}
      </div>

      <PreferenceToggleRow
        label="Check for updates automatically"
        checked={preferences.settings.updatesAutomatic}
        isPending={preferences.isPending("updatesAutomatic")}
        onCheckedChange={(checked) => {
          preferences.choose("updatesAutomatic", checked);
        }}
      />
    </section>
  );
}

/**
 * The one sentence this block announces, or `undefined` while nothing has settled.
 *
 * The `error` arm appends the updater's message: it is a served reading whose content
 * is a failure, and dropping the message would announce that something failed while
 * withholding what.
 */
function updateSettlementSentence(reading: UpdateReading): string | undefined {
  if (reading.kind === "not-read") {
    return undefined;
  }
  return reading.state.status === "error"
    ? `${UPDATE_STATUS_SETTLEMENTS.error} ${reading.state.message}`
    : UPDATE_STATUS_SETTLEMENTS[reading.state.status];
}
