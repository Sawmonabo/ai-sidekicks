// Reads two things a shell's program asks of its terminal out of the shell's output: the title it
// sets for itself (OSC 0 or OSC 2) and whether it wants pasted text marked as pasted (DEC private
// mode 2004, set with `CSI ? 2004 h` and reset with `CSI ? 2004 l`). The sequences stay in the
// output; the scanner only reads them, and one split across reads is read whole. Plain text, most
// of any output, is passed over in one search for the next escape.

import { SHELL_TITLE_MAX_LEN } from "@ai-sidekicks/contracts/pty";

const ESCAPE = 0x1b;
const BELL = 0x07;
const CANCEL = 0x18;
const SUBSTITUTE = 0x1a;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const BACKSLASH = 0x5c;
const QUESTION_MARK = 0x3f;
const SEMICOLON = 0x3b;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const LOWERCASE_H = 0x68;
const LOWERCASE_L = 0x6c;

const BRACKETED_PASTE_MODE = 2004;
// The most of a title kept: every UTF-16 unit the bound keeps is at most three UTF-8 bytes, and
// one character more, at most four, tells whether the last one kept ends its grapheme. A longer
// title is read to its end and cut.
const TITLE_MAX_BYTES = SHELL_TITLE_MAX_LEN * 3 + 4;
// OSC 0 sets the icon name and the title, OSC 2 the title alone.
const TITLE_COMMANDS: ReadonlySet<number> = new Set([0, 2]);
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type ScanState =
  | "ground"
  | "escape"
  | "control-sequence"
  | "operating-system-command"
  | "string-end";

function isDigit(byte: number): boolean {
  return byte >= DIGIT_ZERO && byte <= DIGIT_NINE;
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

/**
 * Follows one shell's title and bracketed-paste mode across its output, fed in output order with
 * the shell's marks already taken out.
 */
export class ShellOutputScanner {
  #state: ScanState = "ground";
  #title: string | null = null;
  #isBracketedPasteRequested = false;
  // The control sequence being read: whether it is a private mode, the number being read, whether
  // it names bracketed paste, and whether an intermediate byte made it some other sequence.
  #isPrivateMode = false;
  #parameter = 0;
  #namesBracketedPaste = false;
  #hasIntermediate = false;
  // The operating system command being read: its number until the first `;`, then, for a title,
  // the title's first bytes, kept until it is known to be no title.
  #command = 0;
  #isCommandRead = false;
  #isTitleKept = false;
  readonly #titleBuffer = new Uint8Array(TITLE_MAX_BYTES);
  #titleByteCount = 0;

  /**
   * The title the shell set for itself, cut to {@link SHELL_TITLE_MAX_LEN} on a grapheme boundary,
   * or `null` until it sets one or after it clears it.
   */
  get title(): string | null {
    return this.#title;
  }

  /** Whether the program in the shell asked for pasted text to be marked as pasted. */
  get isBracketedPasteRequested(): boolean {
    return this.#isBracketedPasteRequested;
  }

  /** Reads the next output; answers whether the title changed. */
  scan(output: Uint8Array): boolean {
    const titleBefore = this.#title;
    let index = 0;
    while (index < output.byteLength) {
      if (this.#state === "ground") {
        // Only an escape leaves the ground state; cancel and substitute keep it.
        const escape = output.indexOf(ESCAPE, index);
        if (escape === -1) {
          break;
        }
        this.#state = "escape";
        index = escape + 1;
        continue;
      }
      this.#step(output[index] ?? 0);
      index += 1;
    }
    return this.#title !== titleBefore;
  }

  // One byte read outside the ground state, which `scan` passes over itself.
  #step(byte: number): void {
    if (byte === CANCEL || byte === SUBSTITUTE) {
      this.#state = "ground";
      return;
    }
    switch (this.#state) {
      case "escape":
        this.#stepEscape(byte);
        return;
      case "control-sequence":
        this.#stepControlSequence(byte);
        return;
      case "operating-system-command":
        this.#stepOperatingSystemCommand(byte);
        return;
      case "string-end":
        // An escape inside a command ends it only as `ESC \`; any other starts a new sequence.
        if (byte === BACKSLASH) {
          this.#endOperatingSystemCommand();
          this.#state = "ground";
          return;
        }
        this.#state = "escape";
        this.#stepEscape(byte);
        return;
    }
  }

  #stepEscape(byte: number): void {
    if (byte === LEFT_BRACKET) {
      this.#isPrivateMode = false;
      this.#parameter = 0;
      this.#namesBracketedPaste = false;
      this.#hasIntermediate = false;
      this.#state = "control-sequence";
    } else if (byte === RIGHT_BRACKET) {
      this.#command = 0;
      this.#isCommandRead = false;
      this.#isTitleKept = true;
      this.#titleByteCount = 0;
      this.#state = "operating-system-command";
    } else if (byte !== ESCAPE) {
      this.#state = "ground";
    }
  }

  #stepControlSequence(byte: number): void {
    if (byte === ESCAPE) {
      this.#state = "escape";
    } else if (byte === QUESTION_MARK && this.#parameter === 0 && !this.#namesBracketedPaste) {
      this.#isPrivateMode = true;
    } else if (isDigit(byte)) {
      // Past the mode's own digits a number can only name another mode, so it stops growing.
      this.#parameter = Math.min(
        this.#parameter * 10 + (byte - DIGIT_ZERO),
        BRACKETED_PASTE_MODE * 10,
      );
    } else if (byte === SEMICOLON) {
      this.#endParameter();
    } else if (byte >= 0x20 && byte <= 0x2f) {
      this.#hasIntermediate = true;
    } else if (byte >= 0x40 && byte <= 0x7e) {
      this.#endParameter();
      if (this.#isPrivateMode && this.#namesBracketedPaste && !this.#hasIntermediate) {
        if (byte === LOWERCASE_H) {
          this.#isBracketedPasteRequested = true;
        } else if (byte === LOWERCASE_L) {
          this.#isBracketedPasteRequested = false;
        }
      }
      this.#state = "ground";
    }
  }

  #endParameter(): void {
    if (this.#parameter === BRACKETED_PASTE_MODE) {
      this.#namesBracketedPaste = true;
    }
    this.#parameter = 0;
  }

  #stepOperatingSystemCommand(byte: number): void {
    if (byte === BELL) {
      this.#endOperatingSystemCommand();
      this.#state = "ground";
      return;
    }
    if (byte === ESCAPE) {
      this.#state = "string-end";
      return;
    }
    if (!this.#isCommandRead) {
      if (isDigit(byte)) {
        // Past one digit the number names no title command, so it stops growing.
        this.#command = Math.min(this.#command * 10 + (byte - DIGIT_ZERO), 10);
      } else {
        this.#isCommandRead = true;
        if (byte !== SEMICOLON || !TITLE_COMMANDS.has(this.#command)) {
          this.#isTitleKept = false;
        }
      }
      return;
    }
    if (!this.#isTitleKept || this.#titleByteCount === TITLE_MAX_BYTES) {
      return;
    }
    this.#titleBuffer[this.#titleByteCount] = byte;
    this.#titleByteCount += 1;
  }

  #endOperatingSystemCommand(): void {
    if (this.#isCommandRead && this.#isTitleKept) {
      const title = cutTitle(
        new TextDecoder().decode(this.#titleBuffer.subarray(0, this.#titleByteCount)),
      );
      this.#title = title.length === 0 ? null : title;
    }
    this.#isTitleKept = false;
  }
}
