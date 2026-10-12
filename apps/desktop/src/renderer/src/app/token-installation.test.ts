// A face that fails to load reaches the window's diagnostic capture with its reason, rather than
// leaving the text it sets in the fallback with nothing said. The test DOM has no font set, so the
// case hands the document one whose loads it answers.

import { describe, expect, it, onTestFinished } from "vitest";

import { collectSentDiagnostics } from "#test/helpers/sent-diagnostics.js";
import { installMeridianTokens } from "./token-installation.js";

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
    const diagnostics = await collectSentDiagnostics();
    onTestFinished(diagnostics.stop);

    installMeridianTokens(targetDocument);
    await Promise.resolve();
    await Promise.resolve();

    const records = (await diagnostics.records()).filter(
      (record) => record.kind === "typeface-not-loaded",
    );
    expect(requestedFaces).toContain('italic 1em "IBM Plex Mono"');
    expect(records).toStrictEqual([
      expect.objectContaining({
        severity: "error",
        detail: "IBM Plex Mono italic did not load: the face's file is unreadable",
      }),
    ]);
  });
});
