// A keyboard chord, rendered the way the operator's platform writes it.
//
// The console's chord grammar is `tinykeys`' (`Spec-023 §Console Libraries`, the
// headless-UI row admits it as the chord parser only), so a binding is authored once
// as `"$mod+KeyK"` and the platform decides what `$mod` looks like. Authoring `"⌘K"`
// at a call site would hard-code macOS into a cross-platform app; authoring
// `"Ctrl+K"` would hard-code Windows into it.
//
// This component decides LAYOUT — a run of keycaps with an accessible label — and
// nothing about vocabulary. What each token prints and how it is spoken comes from
// `chord-format.ts`, its sibling in this family. That single source is not a
// tidiness preference: this file previously kept its own parallel tables, and they
// had diverged — the palette's decoded `KeyK` to `K` and these did not, so every
// hint for a `code`-form binding printed the literal string `KeyK` on a keycap.
//
// The vocabulary used to live in `palette/keybindings.ts`, which made this
// primitive import UP into a family above it. It moved down here instead of the
// import being tolerated: a keycap is a renderer's concern, and the console's
// import graph is the thing that keeps a family reusable.
//
// One thing is worth stating because it is easy to get wrong: **glyphs are shown
// and words are spoken.** A screen reader reads ⌘ as "place of interest sign" and
// ⇧ as "upwards white arrow", which is worse than useless. The visible keys are
// therefore hidden from assistive technology and the whole hint carries a spoken
// label composed from the same tokens — one source, two renderings.

import { HOST_CHORD_PLATFORM, renderChordForPlatform, type ChordPlatform } from "./chord-format.js";

export interface ChordHintProps {
  /** A `tinykeys` chord, e.g. `"$mod+KeyK"`, or a sequence, e.g. `"g s"`. */
  readonly chord: string;
  /**
   * Which platform's convention to print in. Defaults to the host.
   *
   * A parameter rather than always the host so a fixture or a keyboard-settings
   * preview can render another platform's spelling without a global.
   */
  readonly platform?: ChordPlatform;
}

export function ChordHint(props: ChordHintProps): React.JSX.Element {
  const presses = renderChordForPlatform(props.chord, props.platform ?? HOST_CHORD_PLATFORM);
  const keysPerPress = presses.map((press) => [...press.modifiers, press.key]);

  const spokenLabel = keysPerPress
    .map((keys) => keys.map((key) => key.spoken).join(" "))
    .join(", then ");

  return (
    <span className="meridian-chord">
      {/*
       * Visually-hidden TEXT, not `aria-label` on the wrapper. `aria-label` is
       * prohibited on a generic element — a `span` with no role — so the attribute
       * is dropped by some assistive technology and flagged `aria-prohibited-attr`
       * by axe, which is how this was found. Inventing `role="img"` to legalise the
       * attribute would work and read worse: the hint usually sits inside a
       * sentence, and real text composes into that sentence where an image
       * announcement interrupts it.
       */}
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
