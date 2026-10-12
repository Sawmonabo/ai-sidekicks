// How a reply's markdown reads mathematics: `micromark-extension-math`'s syntax, with a single
// dollar read as Pandoc reads it, so a price or a shell variable stays text. A formula between
// single dollars opens on a non-space, closes on a non-space and is not followed by a digit:
// `$x^2$` is a formula, while `$5`, `$HOME` and "$5 and $10" are words. Double dollars are read
// as the library reads them, and a paragraph that is one double-dollar formula is a display one.

import type { RootContent } from "mdast";
import type { Math } from "mdast-util-math";
import { math } from "micromark-extension-math";

/** The parser extension a micromark parse is given, derived from the library's own. */
type MathSyntaxExtension = ReturnType<typeof math>;

/** A construct the extension reads text with, one for the dollar character. */
type TextConstruct = Extract<
  NonNullable<MathSyntaxExtension["text"]>[number],
  { readonly tokenize: unknown }
>;

type Tokenizer = TextConstruct["tokenize"];

type Effects = Parameters<Tokenizer>[0];

type State = Parameters<Tokenizer>[1];

/** A character as the tokenizer reads it: a code point, a negative whitespace code, or the end. */
type CharacterCode = Parameters<State>[0];

/** The dollar sign's code point. */
const DOLLAR = 0x24;

/**
 * The math syntax a reply's markdown is parsed with: flow math as the library reads it, and text
 * math whose single-dollar formulas keep Pandoc's rule. Built per call, as the library's is.
 */
export function mathSyntax(): MathSyntaxExtension {
  const extension = math();
  const textConstruct = extension.text?.[DOLLAR];
  if (textConstruct === undefined || Array.isArray(textConstruct)) {
    throw new Error("The math syntax reads no dollar in text.");
  }
  return {
    ...extension,
    text: { [DOLLAR]: withPandocDollars(textConstruct) },
  };
}

/**
 * Makes each paragraph among `children`, and among their children's, that holds one double-dollar
 * formula and nothing else a display formula, read from `source`, the text they were parsed from.
 */
export function liftDisplayFormulas(children: RootContent[], source: string): void {
  children.forEach((child, index) => {
    if (child.type === "paragraph") {
      const [formula] = child.children;
      const start = formula?.position?.start.offset;
      if (
        child.children.length === 1 &&
        formula?.type === "inlineMath" &&
        start !== undefined &&
        source.startsWith("$$", start)
      ) {
        const display: Math = {
          type: "math",
          meta: null,
          value: formula.value,
          position: child.position,
        };
        children[index] = display;
      }
    } else if (
      child.type === "blockquote" ||
      child.type === "list" ||
      child.type === "listItem" ||
      child.type === "footnoteDefinition"
    ) {
      liftDisplayFormulas(child.children, source);
    }
  });
}

/**
 * `construct` refusing a single-dollar formula that opens or closes on a space or a line end, or
 * that a digit follows, so the dollar is read as text.
 */
function withPandocDollars(construct: TextConstruct): TextConstruct {
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      const consumed: CharacterCode[] = [];
      const recording: Effects = {
        ...effects,
        consume: (code) => {
          consumed.push(code);
          effects.consume(code);
        },
      };
      return construct.tokenize.call(
        this,
        recording,
        (after) => (isPandocFormula(consumed, after) ? ok(after) : nok(after)),
        nok,
      );
    },
  };
}

/** Whether the formula read as `consumed`, then followed by `after`, keeps Pandoc's rule. */
function isPandocFormula(consumed: readonly CharacterCode[], after: CharacterCode): boolean {
  if (consumed[1] === DOLLAR) {
    return true;
  }
  const first = consumed[1];
  const last = consumed[consumed.length - 2];
  return !isSpace(first) && !isSpace(last) && !isDigit(after);
}

/** A space, a tab or a line end; the tokenizer reads tabs and line ends as negative codes. */
function isSpace(code: CharacterCode | undefined): boolean {
  return code === undefined || code === null || code < 0 || code === 0x20;
}

function isDigit(code: CharacterCode): boolean {
  return code !== null && code >= 0x30 && code <= 0x39;
}
