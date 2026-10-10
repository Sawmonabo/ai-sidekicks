// A formula as KaTeX draws it, in Chromium. happy-dom has no layout and no font set, so the
// typesetter's chunk would never load there. A source that does not parse takes the source arm.
// A display formula too wide for its column breaks after its operators. It shrinks until its
// widest piece fits, at any width. Every KaTeX face is in before it is first drawn, so no font
// arriving later moves it. Taking away the measured natural width lets the same formula cross the
// column's edge: the negative control for the fit. Fitting never raises a window error, such as
// the one the browser raises when a resize watch resizes what it watches in the same pass. Glyph
// widths round to whole pixels only on Linux, so only the Linux run shows the refit after a resize
// matters; elsewhere the first measured width already fits. A formula that is only its equation
// number fits too, and an empty one is left unmeasured. A formula inside a sentence is drawn at the
// sentence's size, while a display formula keeps KaTeX's larger size.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { MathBlock } from "#renderer/components/Markdown/MathBlock.js";
import { changeLayout } from "#test/helpers/animation-frame.js";
import { drawnText } from "#test/helpers/live-region.js";

/** How long a formula may take to appear: the typesetter's chunk and its fonts loading. */
const TYPESET_TIMEOUT_MS = 5000;

/** Subpixel slack for a piece's edge against the column's. */
const EDGE_TOLERANCE_PX = 0.5;

/** A long sum: TeX allows a break after every plus. */
const BREAKABLE_CHAIN = Array.from({ length: 24 }, (_, index) => `x_{${String(index + 1)}}`).join(
  " + ",
);

/** One row of letters, too many to fit the narrow columns below side by side. */
const MATRIX_ROW = [..."abcdefghijklmnop"].join(" & ");

/** A short formula with a relation and an operator. */
const ROW_COUNT_FORMULA = String.raw`r = e \cdot y`;

/** KaTeX's own size for a formula, against the text around it (`.katex` in its sheet). */
const KATEX_SIZE_RATIO = 1.21;

/** A column narrower than an equation number drawn at the formula's own size. */
const NARROWER_THAN_A_NUMBER_PX = 12;

/** The chain, then a matrix no break can split. */
const WIDE_FORMULA = String.raw`${BREAKABLE_CHAIN} = ${BREAKABLE_CHAIN} = \begin{pmatrix} ${MATRIX_ROW} \end{pmatrix}`;

afterEach(() => {
  cleanup();
});

describe("browser — a formula drawn by KaTeX", () => {
  it("takes the source arm and says so when the source does not typeset, rather than a formula-shaped blank", async () => {
    // Under a KaTeX told not to throw, a parse error comes back as markup and would be recorded
    // as typeset, so the source would never appear.
    const { container } = render(<MathBlock source={String.raw`\frac{1`} isDisplayMode />, {
      wrapper: LiveAnnouncerProvider,
    });

    await waitFor(
      () => {
        expect(drawnText(container)).toContain("could not be typeset");
      },
      { timeout: TYPESET_TIMEOUT_MS },
    );
    expect(container.querySelector(".meridian-math--source")).not.toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(String.raw`\frac{1`);
    expect(container.querySelector("math")).toBeNull();
  });

  it("breaks and shrinks a wide display formula to its column at every width, in fonts loaded before it is drawn", async () => {
    const windowErrors: string[] = [];
    const recordError = (event: ErrorEvent): void => {
      windowErrors.push(event.message);
    };
    window.addEventListener("error", recordError);
    onTestFinished(() => {
      window.removeEventListener("error", recordError);
    });
    // First drawn narrower than the formula, so the first fit shrinks it.
    const column = document.createElement("div");
    column.style.inlineSize = "120px";
    document.body.append(column);
    onTestFinished(() => {
      column.remove();
    });
    const { container } = render(<MathBlock source={WIDE_FORMULA} isDisplayMode />, {
      container: column,
      wrapper: LiveAnnouncerProvider,
    });
    // Read the faces the moment the formula is in the page: a face still loading then would change
    // the block's height when it arrives.
    const facesAtFirstDraw = await waitFor(
      () => {
        if (container.querySelector(".meridian-math--display") === null) {
          throw new Error("the formula is not typeset yet");
        }
        return katexFaces();
      },
      { timeout: TYPESET_TIMEOUT_MS },
    );
    expect(facesAtFirstDraw).not.toStrictEqual([]);
    expect(facesAtFirstDraw.filter((face) => face.status !== "loaded")).toStrictEqual([]);
    const block = await waitFor(() => {
      const drawn = container.querySelector<HTMLElement>(".meridian-math--display");
      if (drawn === null || drawn.style.getPropertyValue("--math-natural-width") === "") {
        throw new Error("the formula's natural width is not measured yet");
      }
      return drawn;
    });

    // Broken, not only shrunk: one piece sits wholly below another.
    const pieces = pieceRects(block);
    expect(Math.max(...pieces.map((piece) => piece.top))).toBeGreaterThanOrEqual(
      Math.min(...pieces.map((piece) => piece.bottom)),
    );

    for (const width of [480, 240, 120]) {
      await changeLayout(() => {
        column.style.inlineSize = `${String(width)}px`;
      });
      expect(piecesOutside(block), `at ${String(width)} px`).toStrictEqual([]);
    }
    expect(windowErrors).toStrictEqual([]);

    await changeLayout(() => {
      block.style.removeProperty("--math-natural-width");
    });
    expect(piecesOutside(block)).not.toStrictEqual([]);
  });

  it("fits a formula that is only its equation number to a column narrower than the number, and leaves an empty formula unmeasured", async () => {
    // Neither has an unbreakable piece: the number alone sets the first one's width, and the empty
    // one has nothing to fit, so no zero ratio reaches the sheet's division.
    const column = document.createElement("div");
    column.style.inlineSize = `${String(NARROWER_THAN_A_NUMBER_PX)}px`;
    document.body.append(column);
    onTestFinished(() => {
      column.remove();
    });
    const { container } = render(
      <>
        <MathBlock source={String.raw`\tag{1}`} isDisplayMode />
        <MathBlock source="{}" isDisplayMode />
      </>,
      { container: column, wrapper: LiveAnnouncerProvider },
    );
    const { numberOnly, empty } = await waitFor(
      () => {
        const [first, second] = container.querySelectorAll<HTMLElement>(".meridian-math--display");
        if (first === undefined || second === undefined) {
          throw new Error("the formulas are not typeset yet");
        }
        return { numberOnly: first, empty: second };
      },
      { timeout: TYPESET_TIMEOUT_MS },
    );
    // The observers answer on the frames after the formulas are drawn.
    await changeLayout(() => {});

    expect(numberOnly.querySelector(".katex-tag")).not.toBeNull();
    expect(piecesOutside(numberOnly)).toStrictEqual([]);
    expect(empty.style.getPropertyValue("--math-natural-width")).toBe("");
  });

  it("draws a formula inside a sentence at the sentence's size, and a display formula at KaTeX's larger size", async () => {
    const { container } = render(
      <div>
        <p>
          A row count of <MathBlock source={ROW_COUNT_FORMULA} isDisplayMode={false} /> fills the
          table.
        </p>
        <MathBlock source={ROW_COUNT_FORMULA} isDisplayMode />
      </div>,
      { wrapper: LiveAnnouncerProvider },
    );
    const { inline, display } = await waitFor(
      () => {
        const inlineFormula = container.querySelector<HTMLElement>("p .katex");
        const displayFormula = container.querySelector<HTMLElement>(".katex-display > .katex");
        if (inlineFormula === null || displayFormula === null) {
          throw new Error("the formulas are not typeset yet");
        }
        return { inline: inlineFormula, display: displayFormula };
      },
      { timeout: TYPESET_TIMEOUT_MS },
    );
    const sentenceSize = fontSizeOf(container.querySelector("p"));

    expect(fontSizeOf(inline)).toBe(sentenceSize);
    expect(fontSizeOf(display)).toBeCloseTo(sentenceSize * KATEX_SIZE_RATIO, 2);
  });
});

/** Every KaTeX face the page declares, as its family, weight and style beside its load status. */
function katexFaces(): { readonly face: string; readonly status: FontFaceLoadStatus }[] {
  return [...document.fonts]
    .filter((face) => face.family.includes("KaTeX_"))
    .map((face) => ({ face: `${face.family} ${face.weight} ${face.style}`, status: face.status }));
}

/** The rects of KaTeX's unbreakable pieces and equation numbers. */
function pieceRects(block: HTMLElement): DOMRect[] {
  return Array.from(block.querySelectorAll(".katex-base, .katex-tag"), (piece) =>
    piece.getBoundingClientRect(),
  );
}

/**
 * Each piece crossing the column's edge, as its horizontal extent. Read from the pieces' rects
 * rather than `describeHorizontalOverflow`, whose walk counts KaTeX's screen-reader MathML:
 * katex.css clips it into a 1px box, and the `math` inside still reports its full width.
 */
function piecesOutside(block: HTMLElement): string[] {
  const column = block.getBoundingClientRect();
  return pieceRects(block)
    .filter(
      (piece) =>
        piece.left < column.left - EDGE_TOLERANCE_PX ||
        piece.right > column.right + EDGE_TOLERANCE_PX,
    )
    .map((piece) => `${String(piece.left)} to ${String(piece.right)}`);
}

/** An element's computed font size, in pixels. */
function fontSizeOf(element: Element | null): number {
  if (element === null) {
    throw new Error("there is no element to read a font size from");
  }
  return Number.parseFloat(getComputedStyle(element).fontSize);
}
