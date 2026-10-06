// The appearance page: light, dark, or whatever this machine is doing.
//
// It chooses through the window's scheme act and reads the scheme applied on the document
// root, holding no scheme of its own, so it cannot disagree with what the window paints
// (including after the palette's `Color scheme` row moves it). `"system"` is the attribute's
// absence, as the window writes it.

import "./AppearancePage.css";

import { useCallback, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";
import { SCHEME_ATTRIBUTE } from "#shared/appearance.js";
import {
  SYSTEM_SCHEME_PREFERENCE,
  isSchemePreference,
  type SchemePreference,
} from "#renderer/styles/tokens.js";

/** One option and what choosing it means. */
interface SchemeOption {
  readonly preference: SchemePreference;
  readonly label: string;
  readonly description: string;
}

const SCHEME_OPTIONS: readonly SchemeOption[] = [
  {
    preference: SYSTEM_SCHEME_PREFERENCE,
    label: "Follow this machine",
    description:
      "Paints whichever scheme the operating system is in, and keeps " +
      "following it when that changes.",
  },
  {
    preference: "light",
    label: "Light",
    description: "Holds the light scheme whatever the operating system is doing.",
  },
  {
    preference: "dark",
    label: "Dark",
    description: "Holds the dark scheme whatever the operating system is doing.",
  },
];

/** What the appearance page is handed. */
export interface AppearancePageProps {
  /** This window's act for choosing a color scheme. */
  readonly chooseScheme: (preference: SchemePreference) => void;
}

/** The appearance settings page: the color-scheme choice, read from its window's root. */
export function AppearancePage(props: AppearancePageProps): ReactNode {
  const root = useOwnerWindow().document.documentElement;
  const subscribe = useCallback(
    (onSchemeChange: () => void) => subscribeToAppliedScheme(root, onSchemeChange),
    [root],
  );
  const read = useCallback(() => readAppliedScheme(root), [root]);
  const appliedScheme = useSyncExternalStore(subscribe, read, read);

  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        How the app looks on this machine. Kept for this install.
      </p>

      <section className="meridian-settings-page__block" aria-label="Color scheme">
        <h3 className="meridian-settings-page__block-title">Color scheme</h3>
        <RadioGroup
          className="meridian-scheme-choice"
          aria-label="Color scheme"
          value={appliedScheme ?? null}
          onValueChange={(value: unknown) => {
            if (isSchemePreference(value)) {
              props.chooseScheme(value);
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
            title="This window is carrying a scheme this app does not define."
            detail={
              "No option is shown as current, because none of them is. " +
              "Choosing one below replaces it."
            }
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * Watch the applied scheme attribute.
 *
 * A `MutationObserver` rather than a poll: the attribute changes exactly when something
 * writes it.
 */
function subscribeToAppliedScheme(root: HTMLElement, onSchemeChange: () => void): () => void {
  const observer = new MutationObserver(onSchemeChange);
  observer.observe(root, {
    attributes: true,
    attributeFilter: [SCHEME_ATTRIBUTE],
  });
  return () => {
    observer.disconnect();
  };
}

/**
 * What the document is carrying, or `undefined` for a scheme this app does not define.
 *
 * The absent attribute is `"system"`, the frame's own encoding in `app/token-installation.ts`.
 * An unrecognized value is neither a preference nor the system choice, so the page says so
 * instead of lighting up an option nobody chose.
 */
function readAppliedScheme(root: HTMLElement): SchemePreference | undefined {
  const applied = root.getAttribute(SCHEME_ATTRIBUTE);
  if (applied === null) {
    return SYSTEM_SCHEME_PREFERENCE;
  }
  return isSchemePreference(applied) ? applied : undefined;
}
