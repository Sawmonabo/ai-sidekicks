// A refused upload is told what to do EXACTLY ONCE, whichever of two tables answers.
//
// Split from `AttachmentCard.test.tsx`, which owns the card's four arms and the three
// conflations between them. This is a different rule about one of those arms: two
// tables can both answer a refused stream — `repos/artifacts/artifact-refusal-copy.ts`
// answers every `artifact.*` code with a next move, and `attachment-policy.ts` answers
// a refused STREAM with the sentence that belongs in front of its own retry control —
// and the card renders one of them rather than both. It is the seam the two tables' fold
// created, so it is checked where a reader looking for it would look.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AttachmentCard } from "./AttachmentCard.js";
import { INGEST_DISPOSITION_COPY, INGEST_STREAM_INVALID_CODE } from "./attachment-policy.js";
import { TOO_LARGE_CODE, artifactRefusalRecovery } from "../artifacts/artifact-refusal-copy.js";
import { attachmentSourceFrom, type SendingAttachmentIngestEntry } from "./attachment-shapes.js";

const NOW_MILLISECONDS = 1_000;

/**
 * One refused in-flight entry, on the SENDING arm the card's own refusal region needs.
 *
 * A local builder rather than an import from the sibling suite: `apps/desktop/AGENTS.md`
 * admits a co-located spec's own private scaffolding, and hoisting a four-line entry
 * into `test/console/` would put a role there that exactly one directory uses.
 */
function refusedEntry(
  overrides: Partial<SendingAttachmentIngestEntry> = {},
): SendingAttachmentIngestEntry {
  return {
    ...attachmentSourceFrom({
      localId: "attachment-1",
      declaredName: "notes.txt",
      payload: new Blob([new Uint8Array(300)]),
      declaredMediaType: "text/plain",
    }),
    state: "refused",
    receivedBytes: 128,
    ingestId: "ingest-1",
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: NOW_MILLISECONDS,
    lastProgressAtMilliseconds: NOW_MILLISECONDS,
    ...overrides,
  };
}

describe("attachment card — a refused stream is told what to do exactly once", () => {
  // The namespace table answers every `artifact.*` code with a next move and
  // `attachment-policy.ts` answers a refused STREAM with the sentence in front of its
  // own retry control. Both are true and only one belongs on the card: rendering the
  // pair would tell a participant to start the upload again in two sentences that drift
  // the first time either is edited.
  it("renders the disposition's sentence and not the table's general move", () => {
    const { container } = render(
      <AttachmentCard
        reading={{
          kind: "ingesting",
          entry: refusedEntry({
            refusal: { code: INGEST_STREAM_INVALID_CODE, detail: "stream is over" },
            disposition: "restart",
          }),
        }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain(INGEST_DISPOSITION_COPY.restart);
    expect(text).not.toContain(artifactRefusalRecovery(INGEST_STREAM_INVALID_CODE)?.nextMove);
  });

  it("renders the table's move where the refusal carries no disposition", () => {
    // The one that proves the branch above is a choice rather than a suppression: an
    // over-size refusal on a stream with no disposition still reaches the participant
    // with every part the table holds — the cases included, because this entry's move
    // is a lead-in into them and a card that stopped at the colon would name none.
    const recovery = artifactRefusalRecovery(TOO_LARGE_CODE);
    const { container } = render(
      <AttachmentCard
        reading={{
          kind: "ingesting",
          entry: refusedEntry({
            refusal: { code: TOO_LARGE_CODE, detail: "payload is over the bound" },
            disposition: undefined,
          }),
        }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain(recovery?.meaning);
    expect(text).toContain(recovery?.nextMove);
    for (const distinction of recovery?.distinctions ?? []) {
      expect(text).toContain(distinction);
    }
    expect(recovery?.distinctions.length).toBeGreaterThan(0);
  });

  it("negative control: a code the table has no reading for adds no sentence", () => {
    const { container } = render(
      <AttachmentCard
        reading={{
          kind: "ingesting",
          entry: refusedEntry({
            refusal: { code: "session.not_found", detail: "no such session" },
            disposition: undefined,
          }),
        }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelectorAll(".meridian-attachment__note")).toHaveLength(0);
  });
});
