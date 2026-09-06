// The appearance page: light, dark, or whatever this machine is doing.
//
// `Spec-023 §Console Design (Meridian)` §Appearance: "Choose light or dark, and
// nothing else in this release … Mode selection, renderer-local, applied by
// rewriting one style element and cached for the next boot so there is no unstyled
// flash … Never ships user-authored themes in this release … Never renders a color
// the token registry does not define. Three options, no disclosure."
//
// THE PAGE OWNS NEITHER THE APPLY NOR THE WRITE, AND THAT IS DELIBERATE
//
// Applying a scheme is one attribute on the document root and one durable write,
// and the frame already does both in one place (`frame/ConsoleRoot.tsx`): the
// attribute drives the generated sheet's own cascade, and the write goes through
// the persistence chokepoint's `scheme` value class so the choice survives a
// reload. The palette already exposes that act as three registered commands, which
// the command palette offers by name.
//
// So this page CHOOSES through those commands and READS the applied attribute. It
// holds no scheme state of its own, writes nothing durable itself, and cannot drift
// from what the window is actually painting — which a page holding its own copy of
// the preference could, in exactly the window between a palette choice and this
// pane's next render.
//
// WHY THE ATTRIBUTE IS THE READ AND NOT A STORE
//
// The settings page context carries the bridge, the rail, and the open session —
// deliberately not the frame store, whose narrowing that module explains. The
// document root is not a second record of the preference: it is the ONE place the
// preference is applied, written by the frame's own layout effect, and `"system"`
// is represented there exactly as the frame represents it, by the attribute's
// absence. Reading it is reading the frame's answer rather than re-deriving one.
//
// WHAT THIS PAGE DOES NOT OFFER. No theme editor, no accent picker, no density
// control — the design closes this release at the mode choice in terms ("and
// nothing else in this release"), and every colour a person could otherwise pick
// would have to clear the contrast gate the token registry applies at generation
// time, which is the work that buys less than the surfaces this release owes.

import { useCallback, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";

import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import { consoleCommands } from "../../../palette/index.js";
import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import {
  SCHEME_ATTRIBUTE,
  SYSTEM_SCHEME_PREFERENCE,
  isSchemePreference,
  type SchemePreference,
} from "../../../tokens/index.js";
import type { SettingsPageRegistry } from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-appearance";

/** The subsystem name every refusal this module raises carries. */
const APPEARANCE_REFUSAL_ORIGIN = "appearance";

/**
 * One option, its command, and what choosing it means.
 *
 * The command ids are the frame's own registrations, and they are named here
 * because this page is a second entry point into acts the palette already offers —
 * not a second implementation of them. A command id that stopped being registered
 * surfaces as this page's `command-unavailable` refusal rather than as a silent
 * no-op, which is the whole reason the invocation's outcome is read.
 */
interface SchemeOption {
  readonly preference: SchemePreference;
  readonly commandId: string;
  readonly label: string;
  readonly description: string;
}

const SCHEME_OPTIONS: readonly SchemeOption[] = [
  {
    preference: SYSTEM_SCHEME_PREFERENCE,
    commandId: "frame.useSystemScheme",
    label: "Follow this machine",
    description:
      "Paints whichever scheme the operating system is in, and keeps following it when that changes.",
  },
  {
    preference: "light",
    commandId: "frame.useLightScheme",
    label: "Light",
    description: "Holds the light scheme whatever the operating system is doing.",
  },
  {
    preference: "dark",
    commandId: "frame.useDarkScheme",
    label: "Dark",
    description:
      "Holds the dark scheme, which is the one the palette was authored in — light is derived from the same tokens.",
  },
];

/**
 * Watch the applied scheme attribute.
 *
 * A `MutationObserver` and never a poll: the attribute changes exactly when
 * something writes it, and the console's budget forbids a timer on a question the
 * platform will answer by event.
 */
function subscribeToAppliedScheme(onSchemeChange: () => void): () => void {
  if (typeof document === "undefined") {
    return () => undefined;
  }
  const observer = new MutationObserver(onSchemeChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [SCHEME_ATTRIBUTE],
  });
  return () => {
    observer.disconnect();
  };
}

/**
 * What the document is carrying, or `undefined` when it is carrying something this
 * console does not recognise.
 *
 * The absent attribute is `"system"` — that is the frame's own encoding, stated in
 * `frame/token-installation.ts`, and reading it any other way would make this page
 * disagree with the module that wrote it. An unrecognised VALUE is neither a
 * preference nor the system choice, so it answers `undefined` and the page says so
 * rather than lighting up an option nobody chose.
 */
function readAppliedScheme(): SchemePreference | undefined {
  if (typeof document === "undefined") {
    return SYSTEM_SCHEME_PREFERENCE;
  }
  const applied = document.documentElement.getAttribute(SCHEME_ATTRIBUTE);
  if (applied === null) {
    return SYSTEM_SCHEME_PREFERENCE;
  }
  return isSchemePreference(applied) ? applied : undefined;
}

export function AppearancePage(): ReactNode {
  const appliedScheme = useSyncExternalStore(
    subscribeToAppliedScheme,
    readAppliedScheme,
    readAppliedScheme,
  );
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);

  const chooseScheme = useCallback((preference: SchemePreference) => {
    const option = SCHEME_OPTIONS.find((candidate) => candidate.preference === preference);
    if (option === undefined) {
      return;
    }
    // Fail-closed on the registry's own answer. `when` clauses are the frame's, and
    // these three commands carry none, so an empty context evaluates them exactly
    // as the frame's own context would — what is being read here is whether the act
    // is registered at all, which in an auxiliary window or an unmounted frame it
    // may not be.
    const outcome = consoleCommands.invoke(option.commandId, {});
    setRefusal(
      outcome.status === "ran"
        ? undefined
        : refuse(
            APPEARANCE_REFUSAL_ORIGIN,
            "scheme-command-unavailable",
            `The colour scheme was not changed: this window offers no "${option.label}" command right now.`,
          ),
    );
  }, []);

  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Dark is the scheme this console was drawn in, and light is derived from the same tokens
        rather than hand-tuned beside them — so contrast holds in both without a second palette to
        keep in step. The choice belongs to this machine and is remembered for the next start.
      </p>

      <section className="meridian-settings-page__block" aria-label="Colour scheme">
        <h3 className="meridian-settings-page__block-title">Colour scheme</h3>
        <RadioGroup
          className="meridian-scheme-choice"
          aria-label="Colour scheme"
          value={appliedScheme ?? null}
          onValueChange={(value: unknown) => {
            if (isSchemePreference(value)) {
              chooseScheme(value);
            }
          }}
        >
          {SCHEME_OPTIONS.map((option) => (
            <label key={option.preference} className="meridian-scheme-choice__option">
              <Radio.Root value={option.preference} className="meridian-scheme-choice__control">
                <Radio.Indicator className="meridian-scheme-choice__indicator" />
              </Radio.Root>
              <span className="meridian-scheme-choice__text">
                <span className="meridian-scheme-choice__label">{option.label}</span>
                <span className="meridian-scheme-choice__description">{option.description}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {appliedScheme === undefined ? (
          <Nothing
            kind="error"
            placement="inline"
            title="This window is carrying a scheme this console does not define."
            detail="No option is shown as current, because none of them is. Choosing one below replaces it."
          />
        ) : null}
        {refusal === undefined ? null : (
          <InlineRefusal code={refusal.code} detail={refusal.detail} />
        )}
      </section>

      <section className="meridian-settings-page__block" aria-label="Themes">
        <h3 className="meridian-settings-page__block-title">Themes</h3>
        <div className="meridian-settings-page__prose">
          <p>
            There is no theme editor here, and that is a decision rather than an omission. Every
            colour this console paints is checked for contrast when the palette is generated, and a
            colour typed in by hand would either bypass that check or need it re-run on every
            keystroke — so the release ships the two schemes that pass it and nothing that could
            fail it.
          </p>
        </div>
      </section>
    </div>
  );
}

/** Claim the appearance section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerAppearancePage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "appearance",
    owner: OWNER,
    label: "Appearance",
    keywords: ["theme", "dark", "light", "colour", "color", "scheme", "contrast", "display"],
    render: () => <AppearancePage />,
  });
}
