// The appearance page: light, dark, or whatever this machine is doing.
//
// The page chooses through the window's own scheme act, which it is handed, and reads the
// scheme applied on the document root. It holds no scheme of its own and writes nothing
// durable itself, so it cannot disagree with what the window is painting, including just
// after the palette's `Color scheme` row has moved it.
//
// The document root is the read because it is the one place the preference is applied;
// `"system"` is represented there by the attribute's absence, exactly as the window writes
// it.
//
// No theme editor and no accent picker: every color a person could pick would have to
// clear the contrast check the token registry applies when the palette is generated.

import "./appearance.css";

import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { SCHEME_ATTRIBUTE } from "@renderer/styles/generate-css.js";
import {
  SYSTEM_SCHEME_PREFERENCE,
  isSchemePreference,
  type SchemePreference,
} from "@renderer/styles/tokens.js";

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
      "Paints whichever scheme the operating system is in, and keeps following it when that changes.",
  },
  {
    preference: "light",
    label: "Light",
    description: "Holds the light scheme whatever the operating system is doing.",
  },
  {
    preference: "dark",
    label: "Dark",
    description:
      "Holds the dark scheme, which is the one the palette was authored in — light is derived from the same tokens.",
  },
];

/** What the appearance page is handed. */
export interface AppearancePageProps {
  /** This window's act for choosing a color scheme. */
  readonly chooseScheme: (preference: SchemePreference) => void;
}

export function AppearancePage(props: AppearancePageProps): ReactNode {
  const appliedScheme = useSyncExternalStore(
    subscribeToAppliedScheme,
    readAppliedScheme,
    readAppliedScheme,
  );

  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Dark is the scheme this console was drawn in, and light is derived from the same tokens
        rather than hand-tuned beside them — so contrast holds in both without a second palette to
        keep in step. The choice belongs to this machine and is remembered for the next start.
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
            title="This window is carrying a scheme this console does not define."
            detail="No option is shown as current, because none of them is. Choosing one below replaces it."
          />
        ) : null}
      </section>

      <section className="meridian-settings-page__block" aria-label="Themes">
        <h3 className="meridian-settings-page__block-title">Themes</h3>
        <div className="meridian-settings-page__prose">
          <p>
            There is no theme editor here, and that is a decision rather than an omission. Every
            color this console paints is checked for contrast when the palette is generated, and a
            color typed in by hand would either bypass that check or need it re-run on every
            keystroke — so the release ships the two schemes that pass it and nothing that could
            fail it.
          </p>
        </div>
      </section>
    </div>
  );
}

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
 * console does not recognize.
 *
 * The absent attribute is `"system"` — that is the frame's own encoding, stated in
 * `app/token-installation.ts`, and reading it any other way would make this page
 * disagree with the module that wrote it. An unrecognized VALUE is neither a
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
