// Takes a shell's own prompt and command marks out of its output. The marks are OSC 133
// semantic-prompt marks carrying the shell's nonce as a named option, which a terminal that does
// not know the option ignores: `ESC ] 133 ; A ; nonce=<nonce> BEL` before each prompt,
// `... ; C ; ...` before each command and `... ; D ; <exit code> ; ...` before the prompt after
// it. A mark without this shell's nonce, from a printed file, a program or another tool's
// integration, is ordinary output.

// The named option each of the daemon's marks carries the shell's nonce in.
const MARK_NONCE_OPTION = "nonce";

/**
 * A mark the shell reported, at `offset`: the byte index in the read's `output` where it sat. A
 * `command_end` written with no command started since the last prompt carries no exit code.
 */
export type ShellMark =
  | { readonly kind: "prompt"; readonly offset: number }
  | { readonly kind: "command_start"; readonly offset: number }
  | { readonly kind: "command_end"; readonly exitCode: number | null; readonly offset: number };

// One read's output with this shell's marks taken out, and the marks in the order they sat.
interface ShellOutputRead {
  readonly output: Uint8Array;
  readonly marks: readonly ShellMark[];
}

const ESCAPE = 0x1b;
const BELL = 0x07;
const BACKSLASH = 0x5c;
// `ESC ] 133 ;`, the start every semantic-prompt mark shares.
const MARK_INTRODUCER = Uint8Array.of(ESCAPE, 0x5d, 0x31, 0x33, 0x33, 0x3b);
// The string terminator, `ESC \`, the longer of the two terminators a mark may end with.
const STRING_TERMINATOR_LENGTH = 2;
// The longest exit code a shell reports: a signed 32-bit integer.
const LONGEST_EXIT_CODE = "-2147483648";
const MARK_BODY = new RegExp(`^(A|C|D(?:;(-?\\d{1,10}))?);${MARK_NONCE_OPTION}=([^;]*)$`);

type MarkMatch =
  | { readonly kind: "mark"; readonly mark: ShellMark; readonly end: number }
  | { readonly kind: "incomplete" }
  | { readonly kind: "not_a_mark" };

/**
 * Reads one shell's output and takes its marks out. Stateful per shell: a mark split across reads
 * is held until its terminator, but a held prefix longer than the longest mark the daemon writes
 * is not one of its marks and is passed on at once.
 */
export class ShellMarkReader {
  readonly #nonce: string;
  readonly #longestMarkLength: number;
  #held: Uint8Array = new Uint8Array(0);

  constructor(nonce: string) {
    this.#nonce = nonce;
    this.#longestMarkLength =
      MARK_INTRODUCER.length +
      `D;${LONGEST_EXIT_CODE};${MARK_NONCE_OPTION}=`.length +
      nonce.length +
      STRING_TERMINATOR_LENGTH;
  }

  /** Takes this shell's marks out of `chunk`, after any prefix the previous read held. */
  read(chunk: Uint8Array): ShellOutputRead {
    const input = this.#held.length === 0 ? chunk : concatenate([this.#held, chunk]);
    this.#held = new Uint8Array(0);
    const pieces: Uint8Array[] = [];
    const marks: ShellMark[] = [];
    let outputLength = 0;
    let copiedUpTo = 0;
    let passedUpTo = input.length;
    let searchFrom = 0;
    for (;;) {
      const start = input.indexOf(ESCAPE, searchFrom);
      if (start === -1) {
        break;
      }
      const offset = outputLength + start - copiedUpTo;
      const match = this.#matchAt(input, start, offset);
      if (match.kind === "incomplete") {
        // Copied, since the caller may reuse the chunk's memory; a Buffer's own slice is a view.
        this.#held = Uint8Array.prototype.slice.call(input, start);
        passedUpTo = start;
        break;
      }
      if (match.kind === "not_a_mark") {
        searchFrom = start + 1;
        continue;
      }
      pieces.push(input.subarray(copiedUpTo, start));
      outputLength = offset;
      marks.push(match.mark);
      copiedUpTo = match.end;
      searchFrom = match.end;
    }
    if (copiedUpTo === 0 && passedUpTo === input.length) {
      return { output: input, marks };
    }
    pieces.push(input.subarray(copiedUpTo, passedUpTo));
    return { output: concatenate(pieces), marks };
  }

  /** Hands back the prefix the last read held, which is output once the shell has ended. */
  flush(): Uint8Array {
    const held = this.#held;
    this.#held = new Uint8Array(0);
    return held;
  }

  // Whether the bytes from `start`, an escape, are one of this shell's marks, the start of one
  // the input ends inside, or neither. Holding stops at the longest mark's length.
  #matchAt(input: Uint8Array, start: number, offset: number): MarkMatch {
    for (let index = 0; index < MARK_INTRODUCER.length; index += 1) {
      if (start + index === input.length) {
        return { kind: "incomplete" };
      }
      if (input[start + index] !== MARK_INTRODUCER[index]) {
        return { kind: "not_a_mark" };
      }
    }
    const bodyStart = start + MARK_INTRODUCER.length;
    for (let index = bodyStart; index - start < this.#longestMarkLength; index += 1) {
      if (index === input.length) {
        return { kind: "incomplete" };
      }
      const byte = input[index];
      if (byte === BELL) {
        return this.#markFrom(input, bodyStart, index, index + 1, offset);
      }
      if (byte === ESCAPE) {
        if (index + 1 === input.length) {
          return { kind: "incomplete" };
        }
        return input[index + 1] === BACKSLASH
          ? this.#markFrom(input, bodyStart, index, index + STRING_TERMINATOR_LENGTH, offset)
          : { kind: "not_a_mark" };
      }
    }
    return { kind: "not_a_mark" };
  }

  // The mark whose body sits between `bodyStart` and `bodyEnd`, when it is this shell's.
  #markFrom(
    input: Uint8Array,
    bodyStart: number,
    bodyEnd: number,
    end: number,
    offset: number,
  ): MarkMatch {
    const parsed = MARK_BODY.exec(String.fromCharCode(...input.subarray(bodyStart, bodyEnd)));
    if (parsed === null || parsed[3] !== this.#nonce) {
      return { kind: "not_a_mark" };
    }
    const command = parsed[1];
    const exitCode = parsed[2];
    const mark: ShellMark =
      command === "A"
        ? { kind: "prompt", offset }
        : command === "C"
          ? { kind: "command_start", offset }
          : {
              kind: "command_end",
              exitCode: exitCode === undefined ? null : Number(exitCode),
              offset,
            };
    return { kind: "mark", mark, end };
  }
}

function concatenate(pieces: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(pieces.reduce((length, piece) => length + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}
