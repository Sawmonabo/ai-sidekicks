// Shared CommonMark fence-state tracker — the ONE implementation behind every
// fence-aware markdown scanner in the docs-corpus tools (label-cite's heading
// collection, floor/§-cite extractor, and volatile-cite deny; cite-target-
// existence's bare-volatile pass). Call with the blockquote-stripped line; an
// opener may carry an info string (` ```ts `), and a CLOSER is the same
// delimiter character, at least the opener's length, followed by whitespace
// only — a delimiter-looking line with trailing text inside a fence is fence
// content, and a `~~~` cannot close a backtick fence. The naive toggle this
// replaces mis-closed on info-string lines, letting the real closer REOPEN
// the fence over following prose — in the md deny that suppressed checks
// (Codex, PR #207 round 2); in heading collection, the floor extractor, and
// the bare-volatile pass the same flip could silently skip §-verification of
// real anchors or chase quoted example content, so every site shares this
// tracker rather than each porting the rule (PR #207 round 3). Lives in its
// own module because label-cite imports cite-target-existence — a shared
// definition in either would cycle.

export type OpenFenceState = { marker: string; length: number } | null;

export function advanceFenceState(
  unquotedLine: string,
  openFence: OpenFenceState,
): { openFence: OpenFenceState; isDelimiterLine: boolean } {
  // At most three SPACES of indentation (CommonMark): four or more — or a
  // tab, which expands past the limit — makes the line indented-code
  // CONTENT, not a delimiter. The earlier `\s*` treated an indented literal
  // (`    ``` `) as an opener, exempting the ordinary prose after it from
  // the volatile-cite deny and §-cite extraction until the next delimiter
  // (Codex, PR #207 round 3).
  const fenceDelimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(unquotedLine);
  if (fenceDelimiter === null) return { openFence, isDelimiterLine: false };
  if (openFence === null) {
    return {
      openFence: { marker: fenceDelimiter[1][0], length: fenceDelimiter[1].length },
      isDelimiterLine: true,
    };
  }
  if (
    fenceDelimiter[1][0] === openFence.marker &&
    fenceDelimiter[1].length >= openFence.length &&
    fenceDelimiter[2].trim() === ""
  ) {
    return { openFence: null, isDelimiterLine: true };
  }
  return { openFence, isDelimiterLine: true };
}

// Strip blockquote containers for FENCE tracking (`> ```text` opens a fence
// inside a quoted example). Quote DEPTH is deliberately not matched between
// opener and closer — the pragmatic bound for this illustrative-example
// exemption, shared by every scanner that tracks fences.
export function stripBlockquotePrefix(line: string): string {
  return line.replace(/^(?:\s*>)+\s?/, "");
}
