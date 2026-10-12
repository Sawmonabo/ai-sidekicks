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

/** A cell's widest line and widest character, from its characters' advances. */
export interface CellSums {
  readonly widestLinePx: number;
  readonly widestCharacterPx: number;
}

/**
 * Measures a table cell's text in the fonts its cells draw each inline kind in, through one canvas
 * of the table's own document, whose fonts the cells draw in, and a cache of each character's
 * advance and each pair's kerning. A cell is read in place, its runs never gathered, so measuring
 * a long table's cells leaves no garbage. Throws on construction where no canvas can measure.
 */
export class TableCellMeasure {
  readonly #sum: CellSum;
  readonly #wholeLines: CellWholeLines;
  readonly #height: CellHeight;

  /** `ownerDocument` is the table's own: a window's fonts load in its document alone. */
  public constructor(type: TableCellType, ownerDocument: Document) {
    const context = ownerDocument.createElement("canvas").getContext("2d");
    if (context === null) {
      throw new Error("A canvas could not measure a table's text.");
    }
    const fonts = new StyleFonts(type, new TextCanvas(context));
    this.#sum = new CellSum(fonts);
    this.#wholeLines = new CellWholeLines(fonts);
    this.#height = new CellHeight(fonts, new CellLines(type.lineHeightsPx));
  }

  /**
   * A cell's widest line as the sum of its characters' advances and kerning, and its widest
   * character with the edges of a code span or marker it starts or ends. The sums are the
   * measure's own, read before its next call: a table's every cell is summed without garbage.
   */
  public sumCell(cell: TableCell): CellSums {
    const sum = this.#sum;
    sum.start();
    readRuns(cell.children, PLAIN, sum);
    sum.breakLine();
    return sum;
  }

  /** A cell's widest line, each run measured whole, as the browser shapes it. */
  public measureCell(cell: TableCell): number {
    const wholeLines = this.#wholeLines;
    wholeLines.start();
    readRuns(cell.children, PLAIN, wholeLines);
    return Math.max(wholeLines.widestLinePx, wholeLines.linePx);
  }

  /**
   * The height a cell's text takes wrapped at `widthPx` of text width, broken as the browser breaks
   * it, each line as tall as the kinds of text it holds.
   */
  public textHeightOf(cell: TableCell, widthPx: number): number {
    const height = this.#height;
    height.start(Math.max(1, widthPx) + LINE_FIT_TOLERANCE_PX);
    readRuns(cell.children, PLAIN, height);
    return height.finish();
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

/** What reads a cell's text run by run, in the order the renderer draws it. */
interface CellRunReader {
  readText(text: string, style: RunStyle): void;
  breakLine(): void;
}

/** Sums a cell's lines from its characters' advances, and finds its widest character. */
class CellSum implements CellRunReader, CellSums {
  public widestLinePx = 0;
  public linePx = 0;
  public widestCharacterPx = 0;
  readonly #fonts: StyleFonts;

  public constructor(fonts: StyleFonts) {
    this.#fonts = fonts;
  }

  public start(): void {
    this.widestLinePx = 0;
    this.linePx = 0;
    this.widestCharacterPx = 0;
  }

  public readText(text: string, style: RunStyle): void {
    const { advances, edgePx } = this.#fonts.of(style);
    // Summed in locals, which hold a number unboxed, and stored once a run.
    let linePx = this.linePx;
    let widestCharacterPx = this.widestCharacterPx;
    let previous = NO_CHARACTER;
    for (let offset = 0; offset < text.length; ) {
      const codePoint = text.codePointAt(offset) ?? 0;
      const next = offset + (codePoint > 0xffff ? 2 : 1);
      const width = advances.advanceOf(previous, codePoint);
      previous = codePoint;
      // A span's edge sticks to its first and last character, so neither line can drop it.
      widestCharacterPx = Math.max(
        widestCharacterPx,
        width + (offset === 0 ? edgePx : 0) + (next >= text.length ? edgePx : 0),
      );
      linePx += width;
      offset = next;
    }
    this.linePx = linePx + 2 * edgePx;
    this.widestCharacterPx = widestCharacterPx;
  }

  public breakLine(): void {
    this.widestLinePx = Math.max(this.widestLinePx, this.linePx);
    this.linePx = 0;
  }
}

/** Measures a cell's lines, each run shaped whole. */
class CellWholeLines implements CellRunReader {
  public widestLinePx = 0;
  public linePx = 0;
  readonly #fonts: StyleFonts;

  public constructor(fonts: StyleFonts) {
    this.#fonts = fonts;
  }

  public start(): void {
    this.widestLinePx = 0;
    this.linePx = 0;
  }

  public readText(text: string, style: RunStyle): void {
    const { advances, edgePx } = this.#fonts.of(style);
    this.linePx += advances.widthOf(text) + 2 * edgePx;
  }

  public breakLine(): void {
    this.widestLinePx = Math.max(this.widestLinePx, this.linePx);
    this.linePx = 0;
  }
}

/** Fills a cell's lines from its characters' advances, broken where the browser breaks them. */
class CellHeight implements CellRunReader {
  readonly #fonts: StyleFonts;
  readonly #lines: CellLines;
  /** The opening edges of the spans the next character starts. */
  #edgeBeforePx = 0;

  public constructor(fonts: StyleFonts, lines: CellLines) {
    this.#fonts = fonts;
    this.#lines = lines;
  }

  public start(widthPx: number): void {
    this.#lines.start(widthPx);
    this.#edgeBeforePx = 0;
  }

  public readText(text: string, style: RunStyle): void {
    const lines = this.#lines;
    const { advances, edgePx } = this.#fonts.of(style);
    let edgeBeforePx = this.#edgeBeforePx + edgePx;
    let previous = NO_CHARACTER;
    for (let offset = 0; offset < text.length; ) {
      const codePoint = text.codePointAt(offset) ?? 0;
      offset += codePoint > 0xffff ? 2 : 1;
      const advancePx = advances.advanceOf(previous, codePoint);
      previous = codePoint;
      if (isSpace(codePoint)) {
        lines.placeSpace(advancePx);
        continue;
      }
      lines.addCharacter(advancePx + edgeBeforePx, lineKindOf(style, codePoint));
      edgeBeforePx = 0;
      if (isIdeograph(codePoint) || (codePoint === HYPHEN && !lines.isWordStart)) {
        lines.endSegment();
      }
    }
    this.#edgeBeforePx = edgeBeforePx;
    lines.addEdge(edgePx);
  }

  public breakLine(): void {
    this.#lines.breakLine();
  }

  public finish(): number {
    return this.#lines.finish();
  }
}

/** One run style's font, with its measured advances, and the edge a span in it adds each side. */
interface StyleFont {
  readonly advances: FontAdvances;
  readonly edgePx: number;
}

/** Each run style's font, made when the style is first read and kept, by the style's bits. */
class StyleFonts {
  readonly #type: TableCellType;
  readonly #canvas: TextCanvas;
  readonly #byStyle: (StyleFont | undefined)[] = [];
  /** Each font's measured advances, by the font's canvas name: two styles can share a font. */
  readonly #byFont = new Map<string, FontAdvances>();

  public constructor(type: TableCellType, canvas: TextCanvas) {
    this.#type = type;
    this.#canvas = canvas;
  }

  public of(style: RunStyle): StyleFont {
    let styleFont = this.#byStyle[style];
    if (styleFont === undefined) {
      const font = this.#fontOf(style);
      let advances = this.#byFont.get(font);
      if (advances === undefined) {
        advances = new FontAdvances(font, this.#canvas);
        this.#byFont.set(font, advances);
      }
      styleFont = { advances, edgePx: this.#edgeOf(style) };
      this.#byStyle[style] = styleFont;
    }
    return styleFont;
  }

  #fontOf(style: RunStyle): string {
    const type = this.#type;
    const isCode = (style & CODE) !== 0;
    const fontStyle = (style & ITALIC) !== 0 ? type.italicStyle : type.fontStyle;
    const fontWeight = (style & BOLD) !== 0 ? type.boldWeight : type.fontWeight;
    const sizePx = isCode
      ? type.codeFontSizePx
      : (style & FOOTNOTE) !== 0
        ? type.footnoteFontSizePx
        : type.fontSizePx;
    const family = isCode ? type.codeFontFamily : type.fontFamily;
    return `${fontStyle} ${fontWeight} ${String(sizePx)}px ${family}`;
  }

  #edgeOf(style: RunStyle): number {
    if ((style & CODE) !== 0) {
      return this.#type.codeEdgePx;
    }
    return (style & FOOTNOTE) !== 0 ? this.#type.footnoteEdgePx : 0;
  }
}

/**
 * One font's measured advances: each character's, and each pair's kerning counted, measured once.
 * Each is held as the number it is answered as, so answering it makes none.
 */
class FontAdvances {
  readonly #font: string;
  readonly #canvas: TextCanvas;
  readonly #characterAdvances = new Map<number, number>();
  /** How far a pair's second character moves the pen, by its first character, then its second. */
  readonly #pairAdvances = new Map<number, Map<number, number>>();

  public constructor(font: string, canvas: TextCanvas) {
    this.#font = font;
    this.#canvas = canvas;
  }

  /** A run of text's width in this font, shaped whole. */
  public widthOf(text: string): number {
    return this.#canvas.widthOf(this.#font, text);
  }

  /**
   * How far `codePoint` moves the pen after `previous` in one run, the pair's kerning counted;
   * `previous` is `NO_CHARACTER` for a run's first.
   */
  public advanceOf(previous: number, codePoint: number): number {
    if (previous === NO_CHARACTER) {
      return this.#characterAdvanceOf(codePoint);
    }
    let following = this.#pairAdvances.get(previous);
    if (following === undefined) {
      following = new Map();
      this.#pairAdvances.set(previous, following);
    }
    let pairAdvancePx = following.get(codePoint);
    if (pairAdvancePx === undefined) {
      const advancePx = this.#characterAdvanceOf(codePoint);
      const kerningPx =
        this.widthOf(String.fromCodePoint(previous, codePoint)) -
        this.#characterAdvanceOf(previous) -
        advancePx;
      pairAdvancePx = advancePx + kerningPx;
      following.set(codePoint, pairAdvancePx);
    }
    return pairAdvancePx;
  }

  #characterAdvanceOf(codePoint: number): number {
    let advancePx = this.#characterAdvances.get(codePoint);
    if (advancePx === undefined) {
      advancePx = this.widthOf(String.fromCodePoint(codePoint));
      this.#characterAdvances.set(codePoint, advancePx);
    }
    return advancePx;
  }
}

/** A canvas measuring text, its font set only when a measurement names another. */
class TextCanvas {
  readonly #context: CanvasRenderingContext2D;
  /** The font last set on the canvas, as given: the canvas reads it back in another spelling. */
  #font = "";

  public constructor(context: CanvasRenderingContext2D) {
    this.#context = context;
  }

  public widthOf(font: string, text: string): number {
    if (this.#font !== font) {
      this.#font = font;
      this.#context.font = font;
    }
    return this.#context.measureText(text).width;
  }
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
  if ((style & CODE) !== 0) {
    return "code";
  }
  if ((style & FOOTNOTE) !== 0) {
    return "footnote";
  }
  return isIdeograph(codePoint) ? "ideograph" : "plain";
}

/** A run's style: the inline kinds it sits inside, one bit each. */
type RunStyle = number;

const PLAIN: RunStyle = 0;
const BOLD: RunStyle = 1;
const ITALIC: RunStyle = 2;
const CODE: RunStyle = 4;
const FOOTNOTE: RunStyle = 8;

/** The character before a run's first: none, so no pair is kerned. */
const NO_CHARACTER = -1;

/**
 * Gives `reader` a cell's text as the renderer draws it, run by run, with a line's end at each
 * break.
 */
function readRuns(nodes: readonly Nodes[], style: RunStyle, reader: CellRunReader): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "html":
        reader.readText(node.value, style);
        break;
      case "inlineCode":
        reader.readText(node.value, style | CODE);
        break;
      case "break":
        reader.breakLine();
        break;
      case "strong":
        readRuns(node.children, style | BOLD, reader);
        break;
      case "emphasis":
        readRuns(node.children, style | ITALIC, reader);
        break;
      case "image":
      case "imageReference":
        reader.readText(node.alt ?? "", style | ITALIC);
        break;
      case "footnoteReference":
        reader.readText(node.label ?? node.identifier, style | FOOTNOTE);
        break;
      default:
        if ("children" in node) {
          readRuns(node.children, style, reader);
        }
    }
  }
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
