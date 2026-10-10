// How a long table's body cells set their text, and their text measured in it: the fonts each
// inline kind draws in and a cell's box and line, read once from drawn sample rows, and a canvas
// measuring a cell's runs in those fonts. What the table window ranks its rows by and estimates
// undrawn rows from.

import type { Nodes, TableCell } from "mdast";

import { TABLE_LINE_KINDS, type TableLineKind } from "#renderer/components/Markdown/table-offer.js";
import { CellLines, type TableLineHeights } from "./cell-lines.js";

/** How a table's body cells set their text, read from a drawn cell holding each inline kind. */
export interface TableCellType {
  readonly fontStyle: string;
  readonly fontWeight: string;
  readonly fontSizePx: number;
  readonly fontFamily: string;
  /** The weight bold text is drawn at. */
  readonly boldWeight: string;
  /** The style italic text is drawn in. */
  readonly italicStyle: string;
  readonly codeFontFamily: string;
  readonly codeFontSizePx: number;
  /** What each side of an inline code span adds beside its text: its padding and border. */
  readonly codeEdgePx: number;
  readonly footnoteFontSizePx: number;
  /** What each side of a footnote marker adds beside its label. */
  readonly footnoteEdgePx: number;
  /**
   * The height of a line holding each kind of text, measured from drawn rows: a computed
   * `line-height` can be `normal`, which names no length, and a code span, a marker or a fallback
   * font can make a line taller than its plain text.
   */
  readonly lineHeightsPx: TableLineHeights;
  /** A row's height beyond its lines: its cells' vertical padding and its border. */
  readonly rowChromePx: number;
  /** A cell's width beyond its text: its horizontal padding and border. */
  readonly cellChromePx: number;
}

/**
 * Measures a table cell's text in the fonts its cells draw each inline kind in, through one canvas
 * of the table's own document, whose fonts the cells draw in, and a cache of each character's
 * advance and each pair's kerning. Throws on construction where no canvas can measure.
 */
export class TableCellMeasure {
  readonly #type: TableCellType;
  readonly #context: CanvasRenderingContext2D;
  /** Each font's measured advances, by the font's canvas name. */
  readonly #advances = new Map<string, FontAdvances>();
  /** The font last set on the canvas, as given: the canvas reads it back in another spelling. */
  #font = "";

  /** `ownerDocument` is the table's own: a window's fonts load in its document alone. */
  public constructor(type: TableCellType, ownerDocument: Document) {
    this.#type = type;
    const context = ownerDocument.createElement("canvas").getContext("2d");
    if (context === null) {
      throw new Error("A canvas could not measure a table's text.");
    }
    this.#context = context;
  }

  /**
   * A cell's widest line as the sum of its characters' advances and kerning, and its widest
   * character with the edges of a code span or marker it starts or ends.
   */
  public sumCell(cell: TableCell): {
    readonly widestLinePx: number;
    readonly widestCharacterPx: number;
  } {
    let widestLinePx = 0;
    let linePx = 0;
    let widestCharacterPx = 0;
    for (const run of runsOf(cell)) {
      if (run.text === undefined) {
        widestLinePx = Math.max(widestLinePx, linePx);
        linePx = 0;
        continue;
      }
      const advances = this.#advancesOf(this.#fontOf(run.style));
      const edgePx = this.#edgeOf(run.style);
      let previous: number | undefined;
      for (let offset = 0; offset < run.text.length; ) {
        const codePoint = run.text.codePointAt(offset) ?? 0;
        const next = offset + (codePoint > 0xffff ? 2 : 1);
        const width = this.#advanceOf(advances, previous, codePoint);
        previous = codePoint;
        // A span's edge sticks to its first and last character, so neither line can drop it.
        widestCharacterPx = Math.max(
          widestCharacterPx,
          width + (offset === 0 ? edgePx : 0) + (next >= run.text.length ? edgePx : 0),
        );
        linePx += width;
        offset = next;
      }
      linePx += 2 * edgePx;
    }
    return { widestLinePx: Math.max(widestLinePx, linePx), widestCharacterPx };
  }

  /** A cell's widest line, each run measured whole, as the browser shapes it. */
  public measureCell(cell: TableCell): number {
    let widestLinePx = 0;
    let linePx = 0;
    for (const run of runsOf(cell)) {
      if (run.text === undefined) {
        widestLinePx = Math.max(widestLinePx, linePx);
        linePx = 0;
        continue;
      }
      this.#setFont(this.#fontOf(run.style));
      linePx += this.#context.measureText(run.text).width + 2 * this.#edgeOf(run.style);
    }
    return Math.max(widestLinePx, linePx);
  }

  /**
   * The height a cell's text takes wrapped at `widthPx` of text width, broken as the browser breaks
   * it, each line as tall as the kinds of text it holds.
   */
  public textHeightOf(cell: TableCell, widthPx: number): number {
    const lines = new CellLines(
      Math.max(1, widthPx) + LINE_FIT_TOLERANCE_PX,
      this.#type.lineHeightsPx,
    );
    let edgeBeforePx = 0;
    for (const run of runsOf(cell)) {
      if (run.text === undefined) {
        lines.breakLine();
        continue;
      }
      const advances = this.#advancesOf(this.#fontOf(run.style));
      const edgePx = this.#edgeOf(run.style);
      edgeBeforePx += edgePx;
      let previous: number | undefined;
      for (let offset = 0; offset < run.text.length; ) {
        const codePoint = run.text.codePointAt(offset) ?? 0;
        offset += codePoint > 0xffff ? 2 : 1;
        const advancePx = this.#advanceOf(advances, previous, codePoint);
        previous = codePoint;
        if (isSpace(codePoint)) {
          lines.placeSpace(advancePx);
          continue;
        }
        lines.addCharacter(advancePx + edgeBeforePx, lineKindOf(run.style, codePoint));
        edgeBeforePx = 0;
        if (isIdeograph(codePoint) || (codePoint === HYPHEN && !lines.isWordStart)) {
          lines.endSegment();
        }
      }
      lines.addEdge(edgePx);
    }
    return lines.finish();
  }

  #advancesOf(font: string): FontAdvances {
    let advances = this.#advances.get(font);
    if (advances === undefined) {
      advances = {
        font,
        ascii: new Float64Array(128).fill(Number.NaN),
        other: new Map(),
        kerning: new Map(),
      };
      this.#advances.set(font, advances);
    }
    return advances;
  }

  /** How far `codePoint` moves the pen after `previous` in one run, the pair's kerning counted. */
  #advanceOf(advances: FontAdvances, previous: number | undefined, codePoint: number): number {
    const advancePx = this.#characterAdvanceOf(advances, codePoint);
    if (previous === undefined) {
      return advancePx;
    }
    const pair = previous * PAIR_KEY_BASE + codePoint;
    let kerningPx = advances.kerning.get(pair);
    if (kerningPx === undefined) {
      this.#setFont(advances.font);
      kerningPx =
        this.#context.measureText(String.fromCodePoint(previous, codePoint)).width -
        this.#characterAdvanceOf(advances, previous) -
        advancePx;
      advances.kerning.set(pair, kerningPx);
    }
    return advancePx + kerningPx;
  }

  #characterAdvanceOf(advances: FontAdvances, codePoint: number): number {
    const held = codePoint < 128 ? advances.ascii[codePoint] : advances.other.get(codePoint);
    if (held !== undefined && !Number.isNaN(held)) {
      return held;
    }
    this.#setFont(advances.font);
    const width = this.#context.measureText(String.fromCodePoint(codePoint)).width;
    if (codePoint < 128) {
      advances.ascii[codePoint] = width;
    } else {
      advances.other.set(codePoint, width);
    }
    return width;
  }

  #setFont(font: string): void {
    if (this.#font !== font) {
      this.#font = font;
      this.#context.font = font;
    }
  }

  #fontOf(style: RunStyle): string {
    const type = this.#type;
    const fontStyle = style.isItalic ? type.italicStyle : type.fontStyle;
    const fontWeight = style.isBold ? type.boldWeight : type.fontWeight;
    const sizePx = style.isCode
      ? type.codeFontSizePx
      : style.isFootnote
        ? type.footnoteFontSizePx
        : type.fontSizePx;
    const family = style.isCode ? type.codeFontFamily : type.fontFamily;
    return `${fontStyle} ${fontWeight} ${String(sizePx)}px ${family}`;
  }

  #edgeOf(style: RunStyle): number {
    if (style.isCode) {
      return this.#type.codeEdgePx;
    }
    return style.isFootnote ? this.#type.footnoteEdgePx : 0;
  }
}

/**
 * The type of a table's body cells, read from `table` drawn with the type sample rows: a cell
 * holding plain, bold, italic and code text and a footnote marker, then a row of one line of each
 * kind. Throws for a table missing a row or an inline kind.
 */
export function readTableCellType(table: HTMLTableElement): TableCellType {
  const rows = table.tBodies[0]?.rows;
  const cell = rows?.[0]?.cells[0];
  const lineCell = rows?.[1]?.cells[0];
  if (rows === undefined || cell === undefined || lineCell === undefined) {
    throw new Error("A table's type sample rows were not drawn.");
  }
  const bold = cell.querySelector("strong");
  const italic = cell.querySelector("em");
  const code = cell.querySelector("code");
  const footnote = cell.querySelector("sup");
  if (bold === null || italic === null || code === null || footnote === null) {
    throw new Error("A table's type sample cell lacks one of its inline kinds.");
  }
  const view = table.ownerDocument.defaultView;
  if (view === null) {
    throw new Error("A table's type sample rows were read outside a window.");
  }
  const cellStyle = view.getComputedStyle(cell);
  const codeStyle = view.getComputedStyle(code);
  const footnoteStyle = view.getComputedStyle(footnote);
  const lineCellStyle = view.getComputedStyle(lineCell);
  const rowChromePx =
    lengthOf(lineCellStyle.paddingTop) +
    lengthOf(lineCellStyle.paddingBottom) +
    lengthOf(lineCellStyle.borderTopWidth);
  return {
    fontStyle: cellStyle.fontStyle,
    fontWeight: cellStyle.fontWeight,
    fontSizePx: lengthOf(cellStyle.fontSize),
    fontFamily: cellStyle.fontFamily,
    boldWeight: view.getComputedStyle(bold).fontWeight,
    italicStyle: view.getComputedStyle(italic).fontStyle,
    codeFontFamily: codeStyle.fontFamily,
    codeFontSizePx: lengthOf(codeStyle.fontSize),
    codeEdgePx: lengthOf(codeStyle.paddingLeft) + lengthOf(codeStyle.borderLeftWidth),
    footnoteFontSizePx: lengthOf(footnoteStyle.fontSize),
    footnoteEdgePx: lengthOf(footnoteStyle.paddingLeft) + lengthOf(footnoteStyle.borderLeftWidth),
    lineHeightsPx: lineHeightsOf(rows, rowChromePx),
    rowChromePx,
    cellChromePx:
      lengthOf(lineCellStyle.paddingLeft) +
      lengthOf(lineCellStyle.paddingRight) +
      lengthOf(lineCellStyle.borderLeftWidth),
  };
}

/** Each kind of line's height: its sample row's height, less the row's box. */
function lineHeightsOf(
  rows: HTMLCollectionOf<HTMLTableRowElement>,
  rowChromePx: number,
): TableLineHeights {
  const lineHeightOf = (kind: TableLineKind): number => {
    const row = rows[TABLE_LINE_KINDS.indexOf(kind) + 1];
    if (row === undefined) {
      throw new Error(`A table's sample row for a ${kind} line was not drawn.`);
    }
    return row.getBoundingClientRect().height - rowChromePx;
  };
  return {
    plain: lineHeightOf("plain"),
    code: lineHeightOf("code"),
    footnote: lineHeightOf("footnote"),
    ideograph: lineHeightOf("ideograph"),
  };
}

/** The kind of line a character makes: its span's, or an ideograph's in its fallback font. */
function lineKindOf(style: RunStyle, codePoint: number): TableLineKind {
  if (style.isCode) {
    return "code";
  }
  if (style.isFootnote) {
    return "footnote";
  }
  return isIdeograph(codePoint) ? "ideograph" : "plain";
}

/** One font's measured advances: each character's, and each pair's kerning, measured once. */
interface FontAdvances {
  readonly font: string;
  /** ASCII characters' advances, `NaN` until measured. */
  readonly ascii: Float64Array;
  readonly other: Map<number, number>;
  /** What a pair's shaped width differs from its two advances by, keyed by `PAIR_KEY_BASE`. */
  readonly kerning: Map<number, number>;
}

/** One past the largest code point: a pair's key is its first times this, plus its second. */
const PAIR_KEY_BASE = 0x110000;

/** How a run of a cell's text is set: the inline kinds it sits inside. */
interface RunStyle {
  readonly isBold: boolean;
  readonly isItalic: boolean;
  readonly isCode: boolean;
  readonly isFootnote: boolean;
}

/** One run of a cell's text in one style. `undefined` text ends a line. */
type CellRun = { readonly text: string; readonly style: RunStyle } | { readonly text: undefined };

const PLAIN: RunStyle = { isBold: false, isItalic: false, isCode: false, isFootnote: false };

/** A cell's text as the renderer draws it, run by run, with a line's end at each break. */
function runsOf(cell: TableCell): CellRun[] {
  const runs: CellRun[] = [];
  const visit = (node: Nodes, style: RunStyle): void => {
    switch (node.type) {
      case "text":
      case "html":
        runs.push({ text: node.value, style });
        return;
      case "inlineCode":
        runs.push({ text: node.value, style: { ...style, isCode: true } });
        return;
      case "break":
        runs.push({ text: undefined });
        return;
      case "strong":
        visitChildren(node.children, { ...style, isBold: true });
        return;
      case "emphasis":
        visitChildren(node.children, { ...style, isItalic: true });
        return;
      case "image":
      case "imageReference":
        runs.push({ text: node.alt ?? "", style: { ...style, isItalic: true } });
        return;
      case "footnoteReference":
        runs.push({ text: node.label ?? node.identifier, style: { ...style, isFootnote: true } });
        return;
      default:
        if ("children" in node) {
          visitChildren(node.children, style);
        }
    }
  };
  const visitChildren = (children: readonly Nodes[], style: RunStyle): void => {
    for (const child of children) {
      visit(child, style);
    }
  };
  visitChildren(cell.children, PLAIN);
  return runs;
}

/**
 * How far a line's summed advances may pass its width and still fit: the widest cell sets its
 * column to its own width, which the sum can pass by a rounding error. One layout unit, the
 * sixty-fourth of a pixel the browser rounds widths to.
 */
const LINE_FIT_TOLERANCE_PX = 1 / 64;

/** A hyphen-minus, after which a line may break inside a word. */
const HYPHEN = 0x2d;

function isSpace(codePoint: number): boolean {
  return codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x3000;
}

/** A character a line may break after: the CJK ideographs, kana and Hangul syllables. */
function isIdeograph(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3134f)
  );
}

/** A computed length in CSS pixels. Throws for a value that names no length. */
function lengthOf(value: string): number {
  const lengthPx = Number.parseFloat(value);
  if (Number.isNaN(lengthPx)) {
    throw new Error(`A table cell's computed style named no length: ${value}.`);
  }
  return lengthPx;
}
