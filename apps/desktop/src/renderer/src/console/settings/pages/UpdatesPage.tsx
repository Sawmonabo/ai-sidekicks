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
// are composed.

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

import type { UpdateState } from "@ai-sidekicks/contracts";

import { DerivedFigure, Nothing, WireFigure, formatPercent } from "../../primitives/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { PreferenceToggleRow } from "./PreferenceToggleRow.js";
import { useShellPreferences } from "./shell-preferences.js";

/** The one key this block spends. Named once so the row and its note cannot drift. */
const AUTOMATIC_UPDATE_KEY = "updates.automatic";

/**
 * What this block knows about the updater. Total; every arm renders something.
 *
 * `unreachable` is deliberately NOT one of `UpdateState`'s arms: it is the state of
 * the CONVERSATION rather than of the update, and folding it into `error` would
 * attribute a failure to an updater that was never asked.
 */
type UpdateReading =
  | { readonly kind: "not-read" }
  | { readonly kind: "state"; readonly state: UpdateState }
  | { readonly kind: "unreachable"; readonly detail: string };

/**
 * Subscribe to the updater and read its state once, in that order.
 *
 * Subscribe-before-read for the reason every push-driven read in this console gives:
 * a transition landing after the read and before the handler attaches would be lost,
 * and the worst case the other way round is one redundant render.
 */
function useUpdateReading(bridge: ConsoleBridge): UpdateReading {
  const [reading, setReading] = useState<UpdateReading>({ kind: "not-read" });
  useEffect(() => {
    let isAttached = true;
    const settleUnreachable = (thrown: unknown): void => {
      if (isAttached) {
        setReading({
          kind: "unreachable",
          detail: thrown instanceof Error ? thrown.message : String(thrown),
        });
      }
    };
    let release: (() => void) | undefined;
    try {
      release = bridge.sidekicks.update.subscribe((state) => {
        if (isAttached) {
          setReading({ kind: "state", state });
        }
      });
      void bridge.sidekicks.update
        .getState()
        .then((state) => {
          if (isAttached) {
            setReading({ kind: "state", state });
          }
        })
        .catch(settleUnreachable);
    } catch (subscribeRejection: unknown) {
      settleUnreachable(subscribeRejection);
    }
    return () => {
      isAttached = false;
      release?.();
    };
  }, [bridge]);
  return reading;
}

export function UpdatesPage(props: { readonly bridge: ConsoleBridge }): ReactNode {
  const { bridge } = props;
  const reading = useUpdateReading(bridge);
  const preferences = useShellPreferences(bridge);
  const [requestRefusal, setRequestRefusal] = useState<string | undefined>(undefined);
  const isAutomatic = preferences.isEnabled(AUTOMATIC_UPDATE_KEY);
  const isReady = reading.kind === "state" && reading.state.status === "ready";
  // One place a control's rejection becomes a line on screen. The two controls
  // below reach the same bridge namespace and fail the same way, so the handling is
  // written once rather than duplicated per button.
  const runControl = useCallback((perform: () => Promise<void>): void => {
    setRequestRefusal(undefined);
    void perform().catch((rejection: unknown) => {
      setRequestRefusal(rejection instanceof Error ? rejection.message : String(rejection));
    });
  }, []);

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
            runControl(() => bridge.sidekicks.update.requestCheck());
          }}
        >
          Check now
        </button>
        {isReady ? (
          <button
            type="button"
            className="meridian-settings-page__action meridian-settings-page__action--primary"
            onClick={() => {
              runControl(() => bridge.sidekicks.update.requestRestart());
            }}
          >
            Restart to apply
          </button>
        ) : null}
      </div>

      {requestRefusal === undefined ? null : (
        <p className="meridian-settings-page__aside">{requestRefusal}</p>
      )}
    </section>
  );
}

/** The five arms, plus the conversation's own absence. One render per arm. */
function UpdateReadOut(props: { readonly reading: UpdateReading }): React.JSX.Element {
  const { reading } = props;
  // Generated rather than written: two windows can render this block at once, and a
  // hardcoded id would associate one window's label with the other's bar.
  const progressId = useId();
  if (reading.kind === "not-read") {
    return <Nothing kind="not-loaded" placement="inline" title="Reading the updater’s state." />;
  }
  if (reading.kind === "unreachable") {
    // Quiet, and informational. Nothing failed: the update feed was not reached, and
    // saying otherwise would put words in an updater's mouth.
    return (
      <p className="meridian-settings-page__aside">
        The update feed was not reached from this window. <WireFigure value={reading.detail} />
      </p>
    );
  }
  const { state } = reading;
  switch (state.status) {
    case "idle":
      return <p className="meridian-settings-page__state">No update is waiting.</p>;
    case "checking":
      return (
        <p className="meridian-settings-page__state" aria-busy="true">
          Checking for an update…
        </p>
      );
    case "downloading":
      return (
        <div className="meridian-settings-page__state">
          <label className="meridian-settings-page__progress-label" htmlFor={progressId}>
            Downloading
          </label>
          <progress
            className="meridian-settings-page__progress"
            id={progressId}
            max={100}
            value={state.percent}
          />
          <DerivedFigure text={formatPercent(state.percent / 100)} />
        </div>
      );
    case "ready":
      return (
        <p className="meridian-settings-page__state">
          An update has finished downloading and installs on the next restart.
        </p>
      );
    case "error":
      // The updater's own message, verbatim. The retry is the Check now control
      // beside this read-out, which is the one path back.
      return (
        <p
          className="meridian-settings-page__state meridian-settings-page__state--failed"
          role="alert"
        >
          The updater reported a failure. <WireFigure value={state.message} />
        </p>
      );
  }
}
