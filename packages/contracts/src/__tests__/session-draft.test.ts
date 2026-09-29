// The composer store's requests and replies: each accepts the shape the session
// screen sends or draws, and refuses the cases the design names.
import { describe, expect, it } from "vitest";

import {
  SessionAttachmentAddRequestSchema,
  SessionAttachmentAddResponseSchema,
  SessionAttachmentCoverRequestSchema,
  SessionDraftUpdateRequestSchema,
} from "../session-draft.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const ARTIFACT_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAGING_ID = "7d444840-9dc0-41bb-a1a4-4b3a9c1c3d2e";

describe("session.draftUpdate", () => {
  it("accepts an empty draft, which is how Send clears it", () => {
    const request = { sessionId: SESSION_ID, text: "" };
    expect(SessionDraftUpdateRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a member the request does not have", () => {
    const request = { sessionId: SESSION_ID, text: "Fix it", cursor: 3 };
    expect(SessionDraftUpdateRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("session.attachmentAdd", () => {
  it("accepts a picked file and a tool server's resource in one add", () => {
    const request = {
      sessionId: SESSION_ID,
      items: [
        { kind: "file", clientStagingId: STAGING_ID, path: "/Users/me/notes/release-notes.md" },
        {
          kind: "mcpResource",
          clientStagingId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
          serverName: "linear",
          uri: "linear://issue/ENG-42",
        },
      ],
    };
    expect(SessionAttachmentAddRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses an add with nothing to stage", () => {
    expect(
      SessionAttachmentAddRequestSchema.safeParse({ sessionId: SESSION_ID, items: [] }).success,
    ).toBe(false);
  });

  it("refuses an item of a kind staging does not take", () => {
    const request = {
      sessionId: SESSION_ID,
      items: [{ kind: "folder", clientStagingId: STAGING_ID, path: "/Users/me/notes" }],
    };
    expect(SessionAttachmentAddRequestSchema.safeParse(request).success).toBe(false);
  });

  it("accepts the staged set with a picture refused before it was decoded", () => {
    const response = {
      sessionId: SESSION_ID,
      attachments: [
        {
          artifactId: ARTIFACT_ID,
          fileName: "release-notes.md",
          mimeType: "text/markdown",
          sizeBytes: 1536,
        },
      ],
      refused: [
        {
          clientStagingId: STAGING_ID,
          name: "whiteboard.png",
          cause: { code: "artifact.picture_refused", reason: "pixel_limit" },
        },
      ],
    };
    expect(SessionAttachmentAddResponseSchema.safeParse(response).success).toBe(true);
  });

  it("refuses a refusal whose reason belongs to another code", () => {
    const response = {
      sessionId: SESSION_ID,
      attachments: [],
      refused: [
        {
          clientStagingId: STAGING_ID,
          name: "whiteboard.png",
          cause: { code: "artifact.picture_refused", reason: "count_limit" },
        },
      ],
    };
    expect(SessionAttachmentAddResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe("session.attachmentCover", () => {
  const box = { x: 120, y: 40, width: 300, height: 24 };

  it("accepts boxes in the picture's own pixels", () => {
    const request = { attachmentId: ARTIFACT_ID, boxes: [box] };
    expect(SessionAttachmentCoverRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a cover with no box", () => {
    const request = { attachmentId: ARTIFACT_ID, boxes: [] };
    expect(SessionAttachmentCoverRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses a box with no area", () => {
    const request = { attachmentId: ARTIFACT_ID, boxes: [{ ...box, width: 0 }] };
    expect(SessionAttachmentCoverRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses a box that starts outside the picture", () => {
    const request = { attachmentId: ARTIFACT_ID, boxes: [{ ...box, x: -1 }] };
    expect(SessionAttachmentCoverRequestSchema.safeParse(request).success).toBe(false);
  });
});
