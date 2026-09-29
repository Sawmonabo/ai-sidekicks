// Syntax color spans: the one read every surface that draws code asks the daemon
// for, and the vocabulary both ends of it share.
//
// The daemon colors code once and every surface paints what it is handed. A
// reply is a flat list of spans, three numbers each: where the span starts in
// the source, how long it is, and which class it paints as. Plain text carries
// no span. Offsets and lengths count UTF-16 code units, the unit a JavaScript
// string is indexed in, so a surface slices the source it already holds with
// them directly.
//
// A class is an index into `HIGHLIGHT_SPAN_CLASSES`, never a color: the surface
// paints a class through a theme token, so a theme or color-scheme change
// repaints the same spans in place and nothing is colored twice.
//
// The language is a closed set. A surface that cannot name one of these
// languages leaves the code plain and asks for nothing, which is why an
// unknown language is refused here rather than answered with an empty reply.
import { z } from "zod";

import { MAX_MESSAGE_BYTES, jsonUtf8ByteLength } from "./jsonrpc.js";
import type { MethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";

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

/**
 * The classes a span paints as, in wire order: a span's third number is an
 * index into this list. Text that is none of these is plain and has no span.
 */
export const HIGHLIGHT_SPAN_CLASSES = ["keyword", "name", "string", "number", "comment"] as const;

/** One class a span paints as. */
export type HighlightSpanClass = (typeof HIGHLIGHT_SPAN_CLASSES)[number];

/** How many numbers one span takes in a reply: offset, length, class. */
export const HIGHLIGHT_SPAN_WIDTH = 3;

/**
 * The largest source the daemon colors, in UTF-8 bytes as the source travels in
 * the request. Past a quarter mebibyte a block is left plain: coloring it would
 * cost more than the span cache holds for everything else.
 */
export const HIGHLIGHT_SOURCE_MAX_BYTES = 262_144;

/**
 * The largest span list a reply carries, in UTF-8 bytes as it travels. A reply
 * rides one frame, and a frame past `MAX_MESSAGE_BYTES` closes the connection
 * rather than failing the read; 1,024 bytes are held back for the reply's
 * envelope, its echoed request id (at most 256 bytes) and the `spans` key.
 */
export const HIGHLIGHT_SPANS_MAX_BYTES: number = MAX_MESSAGE_BYTES - 1024;

/** The code a surface wants colored. */
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

/** Parses a {@link HighlightReadResponse}, refusing a list a surface could not paint. */
export const HighlightReadResponseSchema: z.ZodType<HighlightReadResponse> = z
  .object({ spans: z.array(z.number().int().nonnegative()) })
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
          message: `a span's class is an index into the ${String(HIGHLIGHT_SPAN_CLASSES.length)} span classes`,
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
        message: `spans measure ${String(spanBytes)} bytes, over the ${String(HIGHLIGHT_SPANS_MAX_BYTES)}-byte reply bound`,
      });
    }
  });

export const HIGHLIGHT_READ_METHOD = "highlight.read" as const;

/** The `highlight.*` methods: one read, answered by the daemon's colorer. */
export interface HighlightMethodDescriptors {
  readonly [HIGHLIGHT_READ_METHOD]: MethodDescriptor<
    typeof HIGHLIGHT_READ_METHOD,
    HighlightReadRequest,
    HighlightReadResponse
  > & { readonly procedureType: "query" };
}

export const HIGHLIGHT_METHOD_DESCRIPTORS: HighlightMethodDescriptors = defineMethodDescriptors({
  [HIGHLIGHT_READ_METHOD]: {
    method: HIGHLIGHT_READ_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: HighlightReadRequestSchema,
    responseSchema: HighlightReadResponseSchema,
  },
});
