// A keyboard chord as keycaps in the platform's spelling; glyphs are shown, words are spoken.

import "./ChordHint.css";

import {
  HOST_CHORD_PLATFORM,
  renderChordForPlatform,
  type ChordPlatform,
} from "@renderer/lib/chord-format.js";

/** Props for `ChordHint`. */
export interface ChordHintProps {
  /** A `tinykeys` chord, e.g. `"$mod+KeyK"`, or a sequence, e.g. `"g s"`. */
  readonly chord: string;
  /** Which platform's spelling to print in. Defaults to the host. */
  readonly platform?: ChordPlatform;
}

/**
 * Draws `chord` as keycaps hidden from assistive technology, plus a visually hidden spoken
 * label built from the same tokens.
 */
export function ChordHint(props: ChordHintProps): React.JSX.Element {
  const presses = renderChordForPlatform(props.chord, props.platform ?? HOST_CHORD_PLATFORM);
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
