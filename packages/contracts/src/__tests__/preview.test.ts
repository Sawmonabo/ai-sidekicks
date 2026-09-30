// The Preview wire as the renderer and the daemon both parse it: the verbs that move
// a session's pages, the address rules, the zoom presets and the marks attachment.
import { describe, expect, it } from "vitest";

import {
  PreviewAddressRefusedDetailsSchema,
  PreviewMarksSendRequestSchema,
  PreviewNavigateRequestSchema,
  PreviewPageListFrameSchema,
  PreviewPageOpenRequestSchema,
  PreviewPageOpenResponseSchema,
  PreviewPageReorderRequestSchema,
  PreviewZoomRequestSchema,
  PREVIEW_FAVICON_MAX_BYTES,
  type PreviewPage,
  type PreviewPageId,
} from "../preview.js";
import { webAddressFault } from "../web-address.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "page-1" as PreviewPageId;

const PAGE: PreviewPage = {
  pageId: PAGE_ID,
  address: "http://localhost:5173/",
  host: "localhost:5173",
  title: "",
  favicon: null,
  loadState: { kind: "loading", progress: null },
  backDepth: 0,
  forwardDepth: 0,
  zoomFactor: 1,
  released: false,
};

describe("preview.pageOpen", () => {
  it("opens on an address or on a discovered dev server", () => {
    const byAddress = { sessionId: SESSION_ID, target: { kind: "address", address: "3000" } };
    const byServer = { sessionId: SESSION_ID, target: { kind: "devServer", port: 5173 } };
    expect(PreviewPageOpenRequestSchema.safeParse(byAddress).success).toBe(true);
    expect(PreviewPageOpenRequestSchema.safeParse(byServer).success).toBe(true);
  });

  it("refuses a target that names both an address and a server", () => {
    const both = {
      sessionId: SESSION_ID,
      target: { kind: "devServer", port: 5173, address: "http://localhost:5173" },
    };
    expect(PreviewPageOpenRequestSchema.safeParse(both).success).toBe(false);
  });

  it("refuses an open with no session", () => {
    expect(
      PreviewPageOpenRequestSchema.safeParse({ target: { kind: "devServer", port: 5173 } }).success,
    ).toBe(false);
  });

  it("answers whether the port moved, never leaving it unsaid", () => {
    const moved = { pageId: PAGE_ID, address: "http://127.0.0.1:5174/", movedFrom: 5173 };
    const unmoved = { pageId: PAGE_ID, address: "http://127.0.0.1:5173/", movedFrom: null };
    expect(PreviewPageOpenResponseSchema.safeParse(moved).success).toBe(true);
    expect(PreviewPageOpenResponseSchema.safeParse(unmoved).success).toBe(true);
    expect(
      PreviewPageOpenResponseSchema.safeParse({ pageId: PAGE_ID, address: "http://x.test/" })
        .success,
    ).toBe(false);
  });
});

describe("preview.address_refused", () => {
  it("names each cause in its closed set and nothing else", () => {
    for (const reason of ["credentials", "scheme", "not_an_address"]) {
      expect(PreviewAddressRefusedDetailsSchema.safeParse({ reason }).success).toBe(true);
    }
    expect(PreviewAddressRefusedDetailsSchema.safeParse({ reason: "searched" }).success).toBe(
      false,
    );
  });
});

describe("the address rules both ends hold an address to", () => {
  it("names a credentialed authority and a foreign scheme, and passes an http(s) address", () => {
    expect(webAddressFault(new URL("https://app@evil.test/looks-like-app"))).toBe("credentials");
    expect(webAddressFault(new URL("http://user:secret@localhost:3000/"))).toBe("credentials");
    expect(webAddressFault(new URL("file:///etc/passwd"))).toBe("scheme");
    expect(webAddressFault(new URL("javascript:alert(1)"))).toBe("scheme");
    expect(webAddressFault(new URL("http://localhost:5173/"))).toBeNull();
    expect(webAddressFault(new URL("https://example.com/a?b"))).toBeNull();
  });
});

describe("preview.pageList frames", () => {
  it("accepts an empty session and a list with its active page", () => {
    expect(PreviewPageListFrameSchema.safeParse({ pages: [], activeIndex: -1 }).success).toBe(true);
    expect(PreviewPageListFrameSchema.safeParse({ pages: [PAGE], activeIndex: 0 }).success).toBe(
      true,
    );
  });

  it("carries a released page with its icon, its zoom and a load that failed", () => {
    const released = {
      ...PAGE,
      favicon: { mediaType: "image/png", data: "iVBORw0KGgo=" },
      loadState: { kind: "failed" },
      zoomFactor: 1.25,
      released: true,
    };
    expect(
      PreviewPageListFrameSchema.safeParse({ pages: [released], activeIndex: 0 }).success,
    ).toBe(true);
  });

  it("refuses an icon past the cap, and one that is not an image", () => {
    const oversized = btoa("x".repeat(PREVIEW_FAVICON_MAX_BYTES + 1));
    const tooLarge = { ...PAGE, favicon: { mediaType: "image/png", data: oversized } };
    const notAnImage = { ...PAGE, favicon: { mediaType: "text/html", data: "iVBORw0KGgo=" } };
    for (const page of [tooLarge, notAnImage]) {
      expect(PreviewPageListFrameSchema.safeParse({ pages: [page], activeIndex: 0 }).success).toBe(
        false,
      );
    }
  });

  it("refuses an active index past the end of the list", () => {
    expect(PreviewPageListFrameSchema.safeParse({ pages: [PAGE], activeIndex: 1 }).success).toBe(
      false,
    );
    expect(PreviewPageListFrameSchema.safeParse({ pages: [], activeIndex: 0 }).success).toBe(false);
  });
});

describe("preview.pageReorder", () => {
  it("accepts a slot in the list without the moved page", () => {
    const request = { sessionId: SESSION_ID, pageId: PAGE_ID, toIndex: 0 };
    expect(PreviewPageReorderRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a negative slot and an extra member", () => {
    const negative = { sessionId: SESSION_ID, pageId: PAGE_ID, toIndex: -1 };
    const extra = { sessionId: SESSION_ID, pageId: PAGE_ID, toIndex: 0, fromIndex: 2 };
    expect(PreviewPageReorderRequestSchema.safeParse(negative).success).toBe(false);
    expect(PreviewPageReorderRequestSchema.safeParse(extra).success).toBe(false);
  });
});

describe("preview.navigate", () => {
  it("takes back, forward and reload on the same verb as an address", () => {
    for (const to of [
      { kind: "back" },
      { kind: "forward" },
      { kind: "reload" },
      { kind: "address", address: "/settings" },
    ]) {
      const request = { sessionId: SESSION_ID, pageId: PAGE_ID, to };
      expect(PreviewNavigateRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it("refuses a navigation it does not know", () => {
    const request = { sessionId: SESSION_ID, pageId: PAGE_ID, to: { kind: "search", q: "x" } };
    expect(PreviewNavigateRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("preview.zoom", () => {
  it("takes the presets, 67 % being 2/3 exactly", () => {
    for (const zoomFactor of [0.5, 2 / 3, 1, 1.25, 2]) {
      const request = { sessionId: SESSION_ID, pageId: PAGE_ID, zoomFactor };
      expect(PreviewZoomRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it("refuses a factor between the presets or past them", () => {
    for (const zoomFactor of [0.67, 1.2, 0.25, 3]) {
      const request = { sessionId: SESSION_ID, pageId: PAGE_ID, zoomFactor };
      expect(PreviewZoomRequestSchema.safeParse(request).success).toBe(false);
    }
  });
});

describe("preview.marksSend", () => {
  const picture = { mediaType: "image/png", data: "iVBORw0KGgo=", width: 2048, height: 1536 };
  const element = { ref: "e17", box: { x: 1, y: 2, width: 30, height: 10 }, snapshotGeneration: 3 };
  const send = (marks: unknown[]) => ({
    sessionId: SESSION_ID,
    pageId: PAGE_ID,
    picture,
    marks,
    address: "http://localhost:5173/",
    pageWidth: 1024,
  });

  it("carries comments, boxes and strokes with the picture they were drawn on", () => {
    const marks = [
      { kind: "comment", number: 1, note: "Too tight", point: { x: 5, y: 6 }, element },
      { kind: "box", number: 2, note: null, rect: { x: 0, y: 0, width: 9, height: 9 }, element },
      { kind: "stroke", points: [{ x: 1, y: 1 }], color: "#e5484d", element: null },
    ];
    expect(PreviewMarksSendRequestSchema.safeParse(send(marks)).success).toBe(true);
  });

  it("refuses an attachment with no mark", () => {
    expect(PreviewMarksSendRequestSchema.safeParse(send([])).success).toBe(false);
  });

  it("refuses a numbered stroke and a stroke color that is not a hex color", () => {
    const numbered = { kind: "stroke", number: 3, points: [{ x: 1, y: 1 }], color: "#e5484d" };
    const named = { kind: "stroke", points: [{ x: 1, y: 1 }], color: "red", element: null };
    expect(
      PreviewMarksSendRequestSchema.safeParse(send([{ ...numbered, element: null }])).success,
    ).toBe(false);
    expect(PreviewMarksSendRequestSchema.safeParse(send([named])).success).toBe(false);
  });

  it("refuses a send without the picture", () => {
    const { picture: _picture, ...withoutPicture } = send([
      { kind: "comment", number: 1, note: null, point: { x: 5, y: 6 }, element: null },
    ]);
    expect(PreviewMarksSendRequestSchema.safeParse(withoutPicture).success).toBe(false);
  });
});
