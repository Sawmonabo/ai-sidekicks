// Where the update stands, and who decides when it lands.
//
// `Spec-023 §Console Design (Meridian)` §Application updates: "An automatic-update
// toggle, and the five-arm state read-out: `idle`, `checking`, `downloading` with
// its percent, `ready`, and `error` with its message. A feed that cannot be reached
// is not an error arm and does not render as one."
//
// THE FIVE ARMS ARE THE WIRE'S, AND THE SIXTH STATE IS NOT AN ARM
//
// `UpdateState` is a registered union on the preload contract and this file renders
// exactly its five members. A bridge that cannot answer at all — the shipped Tier-1
// stub throws, and the fixture has no updater behind it — is a different fact: the
// feed was not reached, nothing failed, and rendering that as `error` would put a
// message on screen that no updater ever wrote. It takes the quiet informational
// line the section asks for.
//
// NOTHING RESTARTS WITHOUT A PRESS, AND `ready` MEANS DOWNLOADED
//
// The restart control exists only on the `ready` arm, because that arm is what the
// updater says when the download has completed; the console never derives readiness
// from a percent, and it invents no percent for an arm that carries none — only
// `downloading` has one, and only `downloading` renders a bar.
//
// This is one BLOCK of the application page rather than a page of its own: the
// section set `Spec-023 §Console Design (Meridian)` fixes has no updates section,
// and `ApplicationPage.tsx` is where the two blocks about the application itself
// are composed. It lives UNDER that page's directory and is named for what it is,
// because a directory of its own under `pages/` registered nothing and read as a
// twelfth page to anyone counting the registrars.

import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { UpdateState } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../../core/index.js";
import { InlineRefusal, useSettlementAnnouncement } from "../../../../primitives/index.js";
import { consoleRefusalFrom } from "../../../../seats/index.js";
import type { ConsoleBridge } from "../../../../bridge/index.js";
import { useSubjectScopedState } from "../../../../store/index.js";
import { PreferenceToggleRow } from "../../../shared/PreferenceToggleRow.js";
import { useShellPreferences } from "../../../shared/shell-preferences/shell-preferences-holder.js";
import { UpdaterReadingHolder, type UpdateReading } from "./updater-reading.js";
import { UpdateReadOut } from "./UpdateReadOut.js";

/** The one key this block spends. Named once so the row and its note cannot drift. */
const AUTOMATIC_UPDATE_KEY = "updates.automatic";

/** Names this block in a refusal a control's failure carried no code of its own on. */
const UPDATE_CONTROL_ORIGIN = "updates";

/** What a control failure with no registered code of its own is called. */
const UPDATE_CONTROL_FAILED = "control-failed";

/**
 * Bind this window's reading of the updater.
 *
 * The holder is constructed in a `useMemo` keyed on the bridge and opened in an
 * effect — never in a render body — which is the shape the sibling preference
 * carrier already takes. The sequencing between the subscription and the opening
 * read is the holder's, not this hook's: two setters racing here is precisely what
 * hid a transition behind the older snapshot.
 */
function useUpdateReading(bridge: ConsoleBridge): UpdateReading {
  const holder = useMemo(() => new UpdaterReadingHolder(bridge.sidekicks.update), [bridge]);
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

/**
 * The one sentence this block announces, or `undefined` while nothing has settled.
 *
 * The `unreachable` arm carries the thrown message rather than a sentence of this
 * console's own, which is the same rule the read-out beside it renders under: the
 * words are whoever refused's, never a paraphrase. The `error` arm appends the
 * updater's message for the same reason — it is a served reading whose content is a
 * failure, and dropping the message would announce that something failed while
 * withholding what.
 */
function updateSettlementSentence(reading: UpdateReading): string | undefined {
  switch (reading.kind) {
    case "not-read":
      return undefined;
    case "unreachable":
      return `The update feed was not reached from this window. ${reading.refusal.detail}`;
    case "state":
      return reading.state.status === "error"
        ? `${UPDATE_STATUS_SETTLEMENTS.error} ${reading.state.message}`
        : UPDATE_STATUS_SETTLEMENTS[reading.state.status];
  }
}

export function UpdatesBlock(props: { readonly bridge: ConsoleBridge }): ReactNode {
  const { bridge } = props;
  const reading = useUpdateReading(bridge);
  // Said once, when the updater read lands. The preference carrier this block also
  // reaches is NOT announced from here: it renders nothing of its own on either
  // outcome — the toggle falls back to its default and the row looks identical — so
  // there is no settlement on screen for an announcement to be the spoken half of.
  useSettlementAnnouncement(updateSettlementSentence(reading));
  const preferences = useShellPreferences(bridge);
  // HELD FOR THE TRANSPORT IT WAS REFUSED BY, through the family's one holder, which
  // is what the two sibling pages already do. A plain state cell outlived a bridge
  // swap, so a line the previous transport wrote stayed on screen underneath one that
  // never refused anything — and the controls beside it now reach a different
  // updater. The key is `undefined` because this block is about no session: the
  // subject alone is what the line may never outlive.
  const { value: requestRefusal, publish: publishRequestRefusal } = useSubjectScopedState<
    ConsoleRefusal | undefined
  >(bridge, undefined, () => undefined);
  const isAutomatic = preferences.isEnabled(AUTOMATIC_UPDATE_KEY);
  const isReady = reading.kind === "state" && reading.state.status === "ready";
  // One place a control's failure becomes a line on screen. The two controls below
  // reach the same bridge namespace and fail the same way, so the handling is
  // written once rather than duplicated per button.
  //
  // THE INVOCATION IS INSIDE THE BOUNDARY, and that is the whole point of the
  // `await`. The shipped Tier-1 bridge implements every updater method as a
  // synchronous `throw`, while the fixture's refusals arrive as rejected promises —
  // so a shape that attached a handler to the RETURNED promise would catch the
  // fixture and let the release build's throw escape the React event handler, with
  // the refusal line never drawn on the one build a person actually runs. Calling
  // `perform` inside the `try` puts both failures on one path, so there is one
  // handler here rather than two branches saying the same sentence.
  const runControl = useCallback(
    async (perform: () => Promise<void>): Promise<void> => {
      publishRequestRefusal(undefined);
      try {
        await perform();
      } catch (rejection: unknown) {
        // Through the console's one converter, so a daemon code reaches the screen.
        // `wireRejectionToError` puts that code on `Error.name` and this site read only
        // `.message`, which discarded every registered code the updater namespace can
        // refuse with — the one part of a refusal rule 9 requires verbatim.
        publishRequestRefusal(
          consoleRefusalFrom(rejection, UPDATE_CONTROL_ORIGIN, UPDATE_CONTROL_FAILED),
        );
      }
    },
    [publishRequestRefusal],
  );

  return (
    <section className="meridian-settings-page__block" aria-label="Application updates">
      <h3 className="meridian-settings-page__block-title">Updates</h3>

      <PreferenceToggleRow
        label="Install updates automatically"
        description="Downloads a new version in the background. Installing it still waits for a restart you choose."
        checked={isAutomatic}
        isPending={preferences.isPending(AUTOMATIC_UPDATE_KEY)}
        note={
          preferences.isHeldLocally(AUTOMATIC_UPDATE_KEY)
            ? "Held in this window. The shell preference store has not been built yet, so the choice lasts until this window closes."
            : undefined
        }
        refusal={preferences.refusalFor(AUTOMATIC_UPDATE_KEY)}
        onCheckedChange={(checked) => {
          preferences.choose(AUTOMATIC_UPDATE_KEY, checked);
        }}
      />

      <UpdateReadOut reading={reading} />

      <div className="meridian-settings-page__actions">
        <button
          type="button"
          className="meridian-settings-page__action"
          onClick={() => {
            void runControl(() => bridge.sidekicks.update.requestCheck());
          }}
        >
          Check now
        </button>
        {isReady ? (
          <button
            type="button"
            className="meridian-settings-page__action meridian-settings-page__action--primary"
            onClick={() => {
              void runControl(() => bridge.sidekicks.update.requestRestart());
            }}
          >
            Restart to apply
          </button>
        ) : null}
      </div>

      {requestRefusal === undefined ? null : <InlineRefusal {...requestRefusal} />}
    </section>
  );
}
