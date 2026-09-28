// Where the update stands, and who decides when it lands.
//
// The five-arm state read-out: `idle`, `checking`, `downloading` with its percent,
// `ready`, and `error` with its message. `UpdateState` is a registered union on the
// preload contract and this file renders exactly its five members.
//
// NOTHING RESTARTS WITHOUT A PRESS, AND `ready` MEANS DOWNLOADED
//
// The restart control exists only on the `ready` arm, because that arm is what the
// updater says when the download has completed; the console never derives readiness
// from a percent, and it invents no percent for an arm that carries none — only
// `downloading` has one, and only `downloading` renders a bar.
//
// A call that throws or rejects is not caught here; it propagates to the caller.

import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { UpdateState } from "@ai-sidekicks/contracts";

import { useSettlementAnnouncement } from "../../../../primitives/index.js";
import { UpdaterReadingHolder, type UpdaterCalls, type UpdateReading } from "./updater-reading.js";
import { UpdateReadOut } from "./UpdateReadOut.js";

/**
 * Bind this window's reading of the updater.
 *
 * The holder is constructed in a `useMemo` keyed on the updater and opened in an
 * effect, never in a render body. The sequencing between the subscription and the
 * opening read is the holder's, not this hook's.
 */
function useUpdateReading(updater: UpdaterCalls): UpdateReading {
  const holder = useMemo(() => new UpdaterReadingHolder(updater), [updater]);
  useEffect(() => {
    holder.open();
    return () => {
      holder.close();
    };
  }, [holder]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => holder.subscribe(onStoreChange),
    [holder],
  );
  const read = useCallback(() => holder.snapshot(), [holder]);
  return useSyncExternalStore(subscribe, read, read).reading;
}

/**
 * What each settled arm of the updater's read SAYS, for the person who cannot see it.
 *
 * TOTAL over `UpdateState`'s own union, so a sixth arm landing upstream is a compile
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
  downloading: "Update state read. An update is downloading.",
  ready: "Update state read. An update has downloaded and installs on the next restart.",
  error: "Update state read. The updater reported a failure.",
};

/** The update block: the updater's state, and the controls that ask it to move. */
export function UpdatesBlock(props: { readonly updater: UpdaterCalls }): ReactNode {
  const { updater } = props;
  const reading = useUpdateReading(updater);
  // Said once, when the updater read lands.
  useSettlementAnnouncement(updateSettlementSentence(reading));
  const isReady = reading.kind === "state" && reading.state.status === "ready";

  return (
    <section className="meridian-settings-page__block" aria-label="Application updates">
      <h3 className="meridian-settings-page__block-title">Updates</h3>

      <UpdateReadOut reading={reading} />

      <div className="meridian-settings-page__actions">
        <button
          type="button"
          className="meridian-settings-page__action"
          onClick={() => {
            void updater.requestCheck();
          }}
        >
          Check now
        </button>
        {isReady ? (
          <button
            type="button"
            className="meridian-settings-page__action"
            aria-label="Restart to apply the downloaded update"
            onClick={() => {
              void updater.requestRestart();
            }}
          >
            Restart to apply
          </button>
        ) : null}
      </div>
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
