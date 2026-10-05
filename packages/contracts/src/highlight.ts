// Syntax color spans: the daemon colors code once and every client paints what it is handed. A
// reply is a flat list of `[offset, length, class]` triples counted in UTF-16 code units, so a
// client slices the source it holds directly. A class is an index into `HIGHLIGHT_SPAN_CLASSES`,
// never a color, so a theme change repaints the same spans. The language is a closed set; an
// unknown one is refused, not answered with an empty reply.
import { z } from "zod";

import { jsonUtf8ByteLength } from "./jsonrpc/jsonrpc.js";
import type { MethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { countSchema } from "./internal/wire-scalars.js";

/** Every language the daemon can color. */
export const HIGHLIGHT_LANGUAGES = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

/** One language the daemon can color. */
export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];

/** Parses a {@link HighlightLanguage}. */
export const HighlightLanguageSchema: z.ZodType<HighlightLanguage, HighlightLanguage> =
  z.enum(HIGHLIGHT_LANGUAGES);

/** The classes a span paints as, in wire order; plain text has no span. */
export const HIGHLIGHT_SPAN_CLASSES = ["keyword", "name", "string", "number", "comment"] as const;

/** One class a span paints as. */
export type HighlightSpanClass = (typeof HIGHLIGHT_SPAN_CLASSES)[number];

/** How many numbers one span takes in a reply: offset, length, class. */
export const HIGHLIGHT_SPAN_WIDTH = 3;

/**
 * The largest source the daemon colors, in UTF-8 bytes as it travels in the request. A larger
 * block is left plain: coloring it would cost more than the span cache holds for everything else.
 */
export const HIGHLIGHT_SOURCE_MAX_BYTES = 262_144;

/**
 * The largest span list a reply carries, in UTF-8 bytes as it travels: its own figure, not derived
 * from the transport's message limit, which the reply with its envelope stays well inside.
 */
export const HIGHLIGHT_SPANS_MAX_BYTES = 998_976;

/** The code a client wants colored. */
export interface HighlightReadRequest {
  language: HighlightLanguage;
  source: string;
}

/** Parses a {@link HighlightReadRequest}; an empty or over-bound source is refused. */
export const HighlightReadRequestSchema: z.ZodType<HighlightReadRequest, HighlightReadRequest> = z
  .object({
    language: HighlightLanguageSchema,
    source: z
      .string()
      .min(1)
      .refine((source) => jsonUtf8ByteLength(source) <= HIGHLIGHT_SOURCE_MAX_BYTES, {
        message: `source is over the ${String(HIGHLIGHT_SOURCE_MAX_BYTES)}-byte bound`,
      }),
  })
  .strict();

/**
 * A source's color spans: `[offset, length, class, offset, length, class, …]`,
 * in source order, never overlapping.
 */
export interface HighlightReadResponse {
  spans: number[];
}

/** Parses a {@link HighlightReadResponse}, refusing a list a client could not paint. */
export const HighlightReadResponseSchema: z.ZodType<HighlightReadResponse> = z
  .object({ spans: z.array(countSchema) })
  .strict()
  .superRefine((response, issueContext) => {
    const { spans } = response;
    if (spans.length % HIGHLIGHT_SPAN_WIDTH !== 0) {
      issueContext.addIssue({
        code: "custom",
        path: ["spans"],
        message: "spans holds three numbers per span: offset, length and class",
      });
      return;
    }
    let previousEnd = 0;
    for (let index = 0; index < spans.length; index += HIGHLIGHT_SPAN_WIDTH) {
      const offset = spans[index] ?? 0;
      const length = spans[index + 1] ?? 0;
      const spanClass = spans[index + 2] ?? 0;
      if (length === 0) {
        issueContext.addIssue({
          code: "custom",
          path: ["spans", index + 1],
          message: "a span covers at least one character",
        });
      }
      if (spanClass >= HIGHLIGHT_SPAN_CLASSES.length) {
        issueContext.addIssue({
          code: "custom",
          path: ["spans", index + 2],
          message:
            `a span's class is an index into the ` +
            `${String(HIGHLIGHT_SPAN_CLASSES.length)} span classes`,
        });
      }
      if (offset < previousEnd) {
        issueContext.addIssue({
          code: "custom",
          path: ["spans", index],
          message: "spans run in source order and never overlap",
        });
      }
      previousEnd = offset + length;
    }
    const spanBytes = jsonUtf8ByteLength(spans);
    if (spanBytes > HIGHLIGHT_SPANS_MAX_BYTES) {
      issueContext.addIssue({
        code: "custom",
        path: ["spans"],
        message:
          `spans measure ${String(spanBytes)} bytes, over the ` +
          `${String(HIGHLIGHT_SPANS_MAX_BYTES)}-byte reply bound`,
      });
    }
  });

/** The wire name of the highlight read. */
export const HIGHLIGHT_READ_METHOD = "highlight.read" as const;

/** The `highlight.*` methods: one read, answered by the daemon's colorer. */
export interface HighlightMethodDescriptors {
  readonly [HIGHLIGHT_READ_METHOD]: MethodDescriptor<
    typeof HIGHLIGHT_READ_METHOD,
    HighlightReadRequest,
    HighlightReadResponse
  >;
}

/** The `highlight.*` descriptor table. */
export const HIGHLIGHT_METHOD_DESCRIPTORS: HighlightMethodDescriptors = defineMethodDescriptors({
  [HIGHLIGHT_READ_METHOD]: {
    method: HIGHLIGHT_READ_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: HighlightReadRequestSchema,
    responseSchema: HighlightReadResponseSchema,
  },
});
