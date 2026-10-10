// A face that fails to load reaches the window's diagnostic capture with its reason, rather than
// leaving the text it sets in the fallback with nothing said. The test DOM has no font set, so the
// case hands the document one whose loads it answers.

import { afterEach, describe, expect, it } from "vitest";

import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { installMeridianTokens } from "./token-installation.js";

let detachForwarder: (() => void) | undefined;

afterEach(() => {
  detachForwarder?.();
  detachForwarder = undefined;
});

describe("installMeridianTokens", () => {
  it("records a face that fails to load, with its reason", async () => {
    const targetDocument = document.implementation.createHTMLDocument();
    const requestedFaces: string[] = [];
    Object.defineProperty(targetDocument, "fonts", {
      value: {
        load: (font: string): Promise<FontFace[]> => {
          requestedFaces.push(font);
          return font === 'italic 1em "IBM Plex Mono"'
            ? Promise.reject(new DOMException("the face's file is unreadable", "NetworkError"))
            : Promise.resolve([]);
        },
      },
    });
    const batches: string[] = [];
    detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });

    installMeridianTokens(targetDocument);
    await Promise.resolve();
    await Promise.resolve();
    windowDiagnosticCapture.flush();

    const records = batches
      .flatMap((batch) => batch.split("\n"))
      .map((line) => JSON.parse(line) as { severity: string; kind: string; detail: string })
      .filter((record) => record.kind === "typeface-not-loaded");
    expect(requestedFaces).toContain('italic 1em "IBM Plex Mono"');
    expect(records).toStrictEqual([
      expect.objectContaining({
        severity: "error",
        detail: "IBM Plex Mono italic did not load: the face's file is unreadable",
      }),
    ]);
  });
});
