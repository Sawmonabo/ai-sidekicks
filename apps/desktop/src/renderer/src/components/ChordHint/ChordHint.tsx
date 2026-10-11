// A keyboard chord as keycaps in the platform's spelling; glyphs are shown, words are spoken.

import "./ChordHint.css";

import type { KeyboardConvention } from "#renderer/lib/chord/convention/contract.js";
import { HOST_KEYBOARD_CONVENTION } from "#renderer/lib/chord/convention/selection.js";
import { renderChordForPlatform } from "#renderer/lib/chord/format.js";

/** Props for `ChordHint`. */
export interface ChordHintProps {
  /** A `tinykeys` chord, e.g. `"$mod+KeyK"`, or a sequence, e.g. `"g s"`. */
  readonly chord: string;
  /** Which system's keyboard to print in. Defaults to the host's. */
  readonly convention?: KeyboardConvention;
}

/**
 * Draws `chord` as keycaps hidden from assistive technology, plus a visually hidden spoken
 * label built from the same tokens.
 */
export function ChordHint(props: ChordHintProps): React.JSX.Element {
  const presses = renderChordForPlatform(props.chord, props.convention ?? HOST_KEYBOARD_CONVENTION);
  const keysPerPress = presses.map((press) => [...press.modifiers, press.key]);

  const spokenLabel = keysPerPress
    .map((keys) => keys.map((key) => key.spoken).join(" "))
    .join(", then ");

  return (
    <span className="meridian-chord">
      {/* Hidden text, not `aria-label`: that is prohibited on a role-less span (axe flags it). */}
      <span className="meridian-visually-hidden">{spokenLabel}</span>
      {keysPerPress.map((keys, pressIndex) => (
        <span
          key={`${String(pressIndex)}:${keys.map((key) => key.glyph).join("+")}`}
          className="meridian-chord__group"
          aria-hidden="true"
        >
          {pressIndex > 0 ? <span className="meridian-chord__then">then</span> : null}
          {keys.map((key, keyIndex) => (
            <kbd key={`${String(keyIndex)}:${key.glyph}`} className="meridian-chord__key">
              {key.glyph}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
