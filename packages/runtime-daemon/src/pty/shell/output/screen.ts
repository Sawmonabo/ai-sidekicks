// The daemon's own copy of one shell's screen, fed every byte of the shell's output with its marks
// taken out and keeping no scrollback of its own. It answers the questions a program asks its
// terminal once, here, as a multiplexer does, so no pane answers and a shell no pane shows still
// gets its answer: the cursor's place, the device's attributes, a mode's state and the text area's
// size from the screen itself, the version from the daemon, and the colors and cell size from the
// appearance last reported, with no answer before one is. It also reads the title the program
// sets (OSC 0 or OSC 2) and whether it asked for pasted text to be marked as pasted (mode 2004).
// The parse runs a turn after the output arrives; `settle` waits for it. The parser is handed one
// chunk at a time, the next as the last is parsed, so a dispose leaves at most that one chunk to
// parse.

import xtermHeadless from "@xterm/headless";
import type { Terminal } from "@xterm/headless";

import type { HexColor } from "@ai-sidekicks/contracts/color";
import {
  SHELL_TITLE_MAX_LEN,
  TERMINAL_PALETTE_LENGTH,
  type TerminalCellSize,
  type TerminalColors,
} from "@ai-sidekicks/contracts/pty";

// The package is CommonJS, so its class is a member of its one export.
const { Terminal: HeadlessTerminal } = xtermHeadless;

const ESCAPE = "\x1b";
const STRING_TERMINATOR = `${ESCAPE}\\`;
// OSC 4 names a palette color; OSC 10, 11 and 12 the foreground, background and cursor, and one
// of them may ask for the next ones too, separated by `;`.
const PALETTE_COLOR_COMMAND = 4;
const DYNAMIC_COLORS: ReadonlyMap<number, "foreground" | "background" | "cursor"> = new Map([
  [10, "foreground"],
  [11, "background"],
  [12, "cursor"],
]);
const QUERY = "?";
// The two window reports answered from the cell size: the text area and one cell, in pixels.
const TEXT_AREA_PIXELS_REPORT = 14;
const CELL_PIXELS_REPORT = 16;
// xterm's 256-color table past the sixteen ANSI colors: a 6×6×6 cube, then 24 grays.
const CUBE_FIRST_INDEX = 16;
const GRAY_FIRST_INDEX = 232;
const LAST_COLOR_INDEX = 255;
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// What a shell's terminal looks like to a program that asks: its colors and its cell size.
interface ShellScreenAppearance {
  readonly colors: TerminalColors | null;
  readonly cellSize: TerminalCellSize | null;
}

/** What a shell's screen copy is built with. */
export interface ShellScreenOptions {
  readonly columns: number;
  readonly rows: number;
  /** What the terminal answers XTVERSION with: its name and version. */
  readonly terminalVersion: string;
  /** Reads the appearance the colors and cell size are answered from, at each question. */
  readonly readAppearance: () => ShellScreenAppearance;
  /** Takes an answer bound for the program, as input to the shell. */
  readonly answer: (bytes: string) => void;
  /** Called when the title the program set changes. */
  readonly onTitleChange: () => void;
}

/** One shell's screen as the daemon keeps it, which answers what a program asks its terminal. */
export class ShellScreen {
  readonly #terminal: Terminal;
  readonly #options: ShellScreenOptions;
  #title: string | null = null;
  #isDisposed = false;
  // Output waiting for the parser to finish the chunk it has, oldest first.
  readonly #unparsed: Uint8Array[] = [];
  #isParsing = false;
  // Each `settle` waiting for the parser to run out of output.
  readonly #settleWaiters: (() => void)[] = [];

  constructor(options: ShellScreenOptions) {
    this.#options = options;
    this.#terminal = new HeadlessTerminal({
      cols: options.columns,
      rows: options.rows,
      scrollback: 0,
      // The parser's handlers are a proposed interface.
      allowProposedApi: true,
      // Each report a program may ask for; without its option the parser drops the question.
      windowOptions: {
        getWinSizeChars: true,
        getWinSizePixels: true,
        getCellSizePixels: true,
      },
    });
    this.#terminal.onData((answer) => {
      options.answer(answer);
    });
    this.#terminal.onTitleChange((title) => {
      const kept = cutTitle(title);
      const next = kept.length === 0 ? null : kept;
      if (next !== this.#title) {
        this.#title = next;
        options.onTitleChange();
      }
    });
    const { parser } = this.#terminal;
    parser.registerCsiHandler({ prefix: ">", final: "q" }, () => {
      options.answer(`${ESCAPE}P>|${options.terminalVersion}${STRING_TERMINATOR}`);
      return true;
    });
    parser.registerCsiHandler({ final: "t" }, (params) => this.#answerWindowReport(params[0]));
    parser.registerOscHandler(PALETTE_COLOR_COMMAND, (data) => this.#answerPaletteColors(data));
    for (const command of DYNAMIC_COLORS.keys()) {
      parser.registerOscHandler(command, (data) => this.#answerDynamicColors(command, data));
    }
  }

  /**
   * The title the program set for itself, cut to {@link SHELL_TITLE_MAX_LEN} on a grapheme
   * boundary, or `null` until it sets one or after it clears it.
   */
  get title(): string | null {
    return this.#title;
  }

  /** Whether the program asked for pasted text to be marked as pasted, as of the output parsed. */
  get isBracketedPasteRequested(): boolean {
    return !this.#isDisposed && this.#terminal.modes.bracketedPasteMode;
  }

  /** Feeds the shell's next output, its marks taken out. */
  write(output: Uint8Array): void {
    if (this.#isDisposed) {
      return;
    }
    if (this.#isParsing) {
      this.#unparsed.push(output);
      return;
    }
    this.#parse(output);
  }

  /** Resolves once every output written so far is parsed, or the screen is let go. */
  settle(): Promise<void> {
    if (this.#isDisposed || !this.#isParsing) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#settleWaiters.push(resolve);
    });
  }

  /** Sizes the screen as the shell is sized. */
  resize(columns: number, rows: number): void {
    if (!this.#isDisposed) {
      this.#terminal.resize(columns, rows);
    }
  }

  /**
   * Lets the screen go once the shell takes no more output, and the output not yet parsed with it;
   * the title stays readable.
   */
  dispose(): void {
    if (!this.#isDisposed) {
      this.#isDisposed = true;
      this.#unparsed.length = 0;
      this.#terminal.dispose();
      this.#endParsing();
    }
  }

  // Hands the parser one chunk, and the next waiting as each is parsed. A chunk handed from the
  // parse callback joins the parser's run under way, so the chain costs no extra turn.
  #parse(output: Uint8Array): void {
    this.#isParsing = true;
    this.#terminal.write(output, () => {
      const next = this.#unparsed.shift();
      if (next !== undefined && !this.#isDisposed) {
        this.#parse(next);
        return;
      }
      this.#endParsing();
    });
  }

  #endParsing(): void {
    this.#isParsing = false;
    for (const resolve of this.#settleWaiters.splice(0)) {
      resolve();
    }
  }

  // CSI 14 t and CSI 16 t; every other report, and every window act, goes on to the parser's own.
  #answerWindowReport(report: number | number[] | undefined): boolean {
    if (report !== TEXT_AREA_PIXELS_REPORT && report !== CELL_PIXELS_REPORT) {
      return false;
    }
    const { cellSize } = this.#options.readAppearance();
    if (cellSize !== null) {
      this.#options.answer(
        report === CELL_PIXELS_REPORT
          ? `${ESCAPE}[6;${String(cellSize.height)};${String(cellSize.width)}t`
          : `${ESCAPE}[4;${String(cellSize.height * this.#terminal.rows)};${String(cellSize.width * this.#terminal.cols)}t`,
      );
    }
    return true;
  }

  // OSC 4 names `index;spec` pairs; each `?` spec asks for that palette color.
  #answerPaletteColors(data: string): boolean {
    const parts = data.split(";");
    const { colors } = this.#options.readAppearance();
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const index = Number(parts[i]);
      if (parts[i + 1] !== QUERY || !Number.isInteger(index) || index < 0) {
        continue;
      }
      const color = colors === null ? undefined : paletteColor(colors, index);
      if (color !== undefined) {
        this.#answerColor(`${String(PALETTE_COLOR_COMMAND)};${String(index)}`, color);
      }
    }
    return true;
  }

  // OSC 10, 11 or 12 with `?` asks for that color, and each `;?` after it for the next one.
  #answerDynamicColors(command: number, data: string): boolean {
    const { colors } = this.#options.readAppearance();
    data.split(";").forEach((spec, offset) => {
      const asked = command + offset;
      const role = DYNAMIC_COLORS.get(asked);
      if (spec === QUERY && colors !== null && role !== undefined) {
        this.#answerColor(String(asked), colors[role]);
      }
    });
    return true;
  }

  #answerColor(prefix: string, color: HexColor): void {
    this.#options.answer(`${ESCAPE}]${prefix};${xtermColorSpec(color)}${STRING_TERMINATOR}`);
  }
}

// The color at `index` of xterm's 256-color table: the reported palette, then the fixed cube and
// gray ramp every xterm-compatible terminal shares.
function paletteColor(colors: TerminalColors, index: number): HexColor | undefined {
  if (index < TERMINAL_PALETTE_LENGTH) {
    return colors.palette[index];
  }
  if (index > LAST_COLOR_INDEX) {
    return undefined;
  }
  if (index >= GRAY_FIRST_INDEX) {
    const level = 8 + (index - GRAY_FIRST_INDEX) * 10;
    return hexOf(level, level, level);
  }
  const cube = index - CUBE_FIRST_INDEX;
  const level = (step: number): number => CUBE_LEVELS[step] ?? 0;
  return hexOf(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6));
}

function hexOf(red: number, green: number, blue: number): HexColor {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

// `#rrggbb` as an X11 color spec, each channel in four hex digits, as xterm answers.
function xtermColorSpec(color: HexColor): string {
  const channels = [1, 3, 5].map((start) => color.slice(start, start + 2).toLowerCase());
  return `rgb:${channels.map((channel) => channel + channel).join("/")}`;
}

// The title cut after its last whole grapheme within the wire's bound, so an emoji or an accented
// letter is never split; a title whose first grapheme alone passes the bound keeps nothing.
function cutTitle(title: string): string {
  if (title.length <= SHELL_TITLE_MAX_LEN) {
    return title;
  }
  let end = 0;
  for (const { index, segment } of GRAPHEME_SEGMENTER.segment(title)) {
    if (index + segment.length > SHELL_TITLE_MAX_LEN) {
      break;
    }
    end = index + segment.length;
  }
  return title.slice(0, end);
}
