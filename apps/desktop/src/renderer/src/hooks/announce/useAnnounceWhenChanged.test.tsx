// When a line's words are said: the rule every drawn line and every read's summary speaks
// through. What the first read settles on stands, a re-read in the same words says nothing, a
// settlement with nothing to say makes whatever follows news, and a new attempt says the same
// words again.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { spiedAnnouncer } from "#test/helpers/spied-announcer.js";
import { useAnnounceWhenChanged } from "./useAnnounceWhenChanged.js";

/** What one render hands the hook. */
interface ShownLine {
  readonly sentence: string | null | undefined;
  readonly attempt?: unknown;
}

/** The hook alone, with nothing beside it that could speak. */
function LineProbe(props: ShownLine & { readonly isReadSettlement: boolean }): null {
  useAnnounceWhenChanged(props.sentence, "polite", {
    attempt: props.attempt,
    isReadSettlement: props.isReadSettlement,
  });
  return null;
}

/** Draw `lines` one render after another and answer what was said. */
function spokenAcross(
  lines: readonly ShownLine[],
  options: { readonly isReadSettlement: boolean },
): readonly string[] {
  const said = spiedAnnouncer();
  const drawn = (line: ShownLine): React.JSX.Element => (
    <LiveAnnouncerProvider announcer={said.announcer}>
      <LineProbe {...line} isReadSettlement={options.isReadSettlement} />
    </LiveAnnouncerProvider>
  );
  const [first, ...later] = lines;
  if (first === undefined) {
    throw new Error("draw at least one line");
  }
  const { rerender } = render(drawn(first));
  for (const line of later) {
    rerender(drawn(line));
  }
  return said.spoken();
}

describe("a read's settled sentence", () => {
  it("leaves the first settlement and a re-read in its words unsaid, and says a change", () => {
    expect(
      spokenAcross(
        [
          { sentence: undefined },
          { sentence: "3 runs listed." },
          { sentence: undefined },
          { sentence: "3 runs listed." },
          { sentence: "4 runs listed." },
        ],
        { isReadSettlement: true },
      ),
    ).toStrictEqual(["4 runs listed."]);
  });

  it("says what follows a settlement with nothing to say, even the words said before it", () => {
    // The first read failed, the retry listed runs, a later read failed, and the next listed the
    // same runs: each listing follows a settlement that said nothing, so each is news.
    expect(
      spokenAcross(
        [
          { sentence: null },
          { sentence: "3 runs listed." },
          { sentence: null },
          { sentence: "3 runs listed." },
        ],
        { isReadSettlement: true },
      ),
    ).toStrictEqual(["3 runs listed.", "3 runs listed."]);
  });
});

describe("a drawn line", () => {
  it("says the same words again only for a new attempt", () => {
    const firstFailure = { code: "chunk-failed" };
    const retriedFailure = { code: "chunk-failed" };
    expect(
      spokenAcross(
        [
          { sentence: "Could not load the terminal", attempt: firstFailure },
          { sentence: undefined },
          { sentence: "Could not load the terminal", attempt: firstFailure },
          { sentence: undefined },
          { sentence: "Could not load the terminal", attempt: retriedFailure },
        ],
        { isReadSettlement: false },
      ),
    ).toStrictEqual(["Could not load the terminal", "Could not load the terminal"]);
  });
});
