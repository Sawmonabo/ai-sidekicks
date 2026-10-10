// The faces merman asks the page to measure labels in when a diagram names none of its own, under
// the site configuration the worker draws with: the palette's family at the palette's size, plus
// the families and sizes merman's renderer modules fix for their diagram types, each group below
// naming the `merman-render` modules it comes from. A diagram's front matter, `init`, class and
// style statements can name any other face, and treemap sizes its labels to their boxes, so this
// list is what launch warms ahead; any other face is warmed when asked.

import type { DiagramPalette } from "./palette.js";
import type { LabelFace } from "./worker/messages.js";

/** The faces merman measures labels in by default for diagrams drawn with `palette`. */
export function defaultLabelFacesFor(palette: DiagramPalette): LabelFace[] {
  const site = palette.fontSizePx;
  const family = palette.fontFamily;
  const fonts = [
    // Most modules draw labels in the site face; `requirement` bolds its names, `class` its
    // titles, and `timeline` sizes its title from the site size.
    `normal normal ${String(site)}px ${family}`,
    `normal bold ${String(site)}px ${family}`,
    `normal bolder ${String(site)}px ${family}`,
    `normal bold ${String(site * 1.9375)}px ${family}`,
    // Sizes `gitgraph`, `gantt`, `cynefin`, `er`, `ishikawa`, `architecture`, `mindmap`,
    // `tree_view`, `eventmodeling`, `pie` and `xychart` fix in the site family.
    `normal normal 10px ${family}`,
    `normal normal 11px ${family}`,
    `normal normal 12px ${family}`,
    `normal normal 14px ${family}`,
    `normal 600 14px ${family}`,
    `normal normal 16px ${family}`,
    `normal bold 16px ${family}`,
    `normal 700 16px ${family}`,
    `normal normal 17px ${family}`,
    `normal normal 20px ${family}`,
    `normal normal 25px ${family}`,
    // `class`, `er`, `requirement` and `sequence` also measure in plain sans-serif.
    `normal normal ${String(site)}px sans-serif`,
    // `c4` and `eventmodeling`.
    "normal normal 12px sans-serif",
    "normal normal 14px sans-serif",
    "normal bold 16px sans-serif",
    "normal 700 16px sans-serif",
    // `c4` (its boundary, message and shrunk description sizes) and `usecase`.
    `normal normal 10.5px ${OPEN_SANS_FAMILY}`,
    `normal normal ${String(14 * 0.82)}px ${OPEN_SANS_FAMILY}`,
    `normal normal 12px ${OPEN_SANS_FAMILY}`,
    `normal normal 14px ${OPEN_SANS_FAMILY}`,
    `normal bold 14px ${OPEN_SANS_FAMILY}`,
    `normal bold 16px ${OPEN_SANS_FAMILY}`,
    // `eventmodeling`'s bold labels and `treemap`'s section labels.
    `normal 700 16px ${TREBUCHET_FAMILY}`,
    `normal bold 12px ${TREBUCHET_FAMILY}`,
    // `architecture`'s layout default and `zenuml`'s.
    "normal normal 16px Helvetica Neue,Helvetica,sans-serif",
    "normal normal 16px Helvetica, Verdana, serif",
  ];
  return fonts.map((font) => ({ font, letterSpacingPx: 0, wordSpacingPx: 0 }));
}

/** merman's own default family (`config`), which `treemap` and `eventmodeling` keep. */
const TREBUCHET_FAMILY = '"trebuchet ms",verdana,arial,sans-serif';
/** The family `c4` and `usecase` default to. */
const OPEN_SANS_FAMILY = '"Open Sans", sans-serif';
