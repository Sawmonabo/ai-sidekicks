// Measures diagram labels for the worker with the page's own canvas, in the faces the picture draws
// with, so the worker loads no face of its own. It measures a little at a time while the main
// thread is idle, at most `SLICE_MS` at a time, so measuring stays out of busy frames. A window
// drawing no frames may grant no idle time at all, so a wait past `IDLE_WAIT_MS` measures one slice
// anyway rather than starve the ask. A face's first measurement loads the face, up to 8 ms cold, so
// each face is loaded once, alone in a task of its own: the faces handed to `warm` one per idle
// callback while no ask waits, and the faces an ask needs that are still cold back to back after
// its idle wait, before its labels are measured.

import type { LabelFace, LabelMeasureRequest, LabelMeasurements } from "./worker/messages.js";

/** Measures the labels each ask names, in idle time, and answers each ask whole, in order. */
export class LabelMeasurer {
  readonly #asks: PendingAsk[] = [];
  /** Faces to load while no ask waits. */
  readonly #facesToWarm: LabelFace[] = [];
  /** Every face loaded, by the canvas's own spelling of its font. */
  readonly #warmFonts = new Set<string>();
  #context: OffscreenCanvasRenderingContext2D | undefined;
  /** The face last set on the canvas, so a face is set only when it changes. */
  #face: LabelFace | undefined;
  /** Whether an idle callback or a loading task is coming, which every turn of work waits on. */
  #isScheduled = false;

  /** Load `faces` in idle time, one per idle callback, before any label needs them. */
  public warm(faces: readonly LabelFace[]): void {
    this.#facesToWarm.push(...faces);
    this.#schedule();
  }

  /** Measure `labels`; resolves with every face's measurements once all are measured. */
  public measure(labels: readonly LabelMeasureRequest[]): Promise<LabelMeasurements[]> {
    return new Promise((resolve) => {
      this.#asks.push({ labels, resolve, measured: [], faceIndex: 0, widths: [] });
      this.#schedule();
    });
  }

  #schedule(): void {
    if (this.#isScheduled || (this.#asks.length === 0 && this.#facesToWarm.length === 0)) {
      return;
    }
    this.#isScheduled = true;
    requestIdleCallback(
      (deadline) => {
        this.#isScheduled = false;
        this.#workWhileIdle(deadline);
      },
      { timeout: IDLE_WAIT_MS },
    );
  }

  #workWhileIdle(deadline: IdleDeadline): void {
    if (this.#asks.length === 0) {
      let face = this.#facesToWarm.shift();
      while (face !== undefined && this.#isWarm(face)) {
        face = this.#facesToWarm.shift();
      }
      if (face !== undefined) {
        this.#warmFace(face);
      }
      this.#schedule();
      return;
    }
    const coldFaces = this.#coldFacesOfNextAsk();
    if (coldFaces.length > 0) {
      this.#isScheduled = true;
      this.#warmInTurn(coldFaces);
      return;
    }
    // Every slice ends by the wall clock, whatever the idle grant, so a thread taken off the
    // processor mid-slice cannot stretch it across a frame.
    const sliceEnd = performance.now() + SLICE_MS;
    this.#measureSlice(
      deadline.didTimeout
        ? () => performance.now() < sliceEnd
        : () => performance.now() < sliceEnd && deadline.timeRemaining() > IDLE_FLOOR_MS,
    );
  }

  /** Load `faces` one per task, back to back, then measure a slice. */
  #warmInTurn(faces: readonly LabelFace[]): void {
    const [face, ...rest] = faces;
    if (face !== undefined) {
      this.#warmFace(face);
    }
    this.#runAsTask(() => {
      if (rest.length > 0) {
        this.#warmInTurn(rest);
        return;
      }
      this.#isScheduled = false;
      const sliceEnd = performance.now() + SLICE_MS;
      this.#measureSlice(() => performance.now() < sliceEnd);
    });
  }

  /** Measure the asks in order while `hasTime`, stopping at a face not yet loaded. */
  #measureSlice(hasTime: () => boolean): void {
    let ask = this.#asks[0];
    while (ask !== undefined && hasTime()) {
      const request = ask.labels[ask.faceIndex];
      if (request === undefined) {
        this.#asks.shift();
        ask.resolve(ask.measured);
        ask = this.#asks[0];
        continue;
      }
      if (!this.#isWarm(request.face)) {
        break;
      }
      const context = this.#contextFor(request.face);
      const text = request.texts[ask.widths.length];
      if (text === undefined) {
        const face = context.measureText("");
        ask.measured.push({
          face: request.face,
          lineHeight: face.fontBoundingBoxAscent + face.fontBoundingBoxDescent,
          texts: request.texts,
          widths: ask.widths,
        });
        ask.faceIndex += 1;
        ask.widths = [];
        continue;
      }
      ask.widths.push(Math.max(0, context.measureText(text).width));
    }
    this.#schedule();
  }

  /** The faces the next ask still needs that are not loaded, each once. */
  #coldFacesOfNextAsk(): LabelFace[] {
    const ask = this.#asks[0];
    const coldFaces = new Map<string, LabelFace>();
    for (const { face } of ask?.labels.slice(ask.faceIndex) ?? []) {
      const font = this.#contextFor(face).font;
      if (!this.#warmFonts.has(font) && !coldFaces.has(font)) {
        coldFaces.set(font, face);
      }
    }
    return [...coldFaces.values()];
  }

  #isWarm(face: LabelFace): boolean {
    return this.#warmFonts.has(this.#contextFor(face).font);
  }

  /** Load `face` with its first measurement. */
  #warmFace(face: LabelFace): void {
    const context = this.#contextFor(face);
    // The slice cap holds for work that splits; a first load cannot, so it runs alone in its task
    // and is held to the 8.3 ms a task may take.
    context.measureText("");
    this.#warmFonts.add(context.font);
  }

  /** Run `step` in a task of its own, queued behind what the thread already has, with no wait. */
  #runAsTask(step: () => void): void {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      step();
    };
    channel.port2.postMessage(undefined);
  }

  /** The canvas, set to `face`; setting a face parses its font and loads nothing. */
  #contextFor(face: LabelFace): OffscreenCanvasRenderingContext2D {
    const context = (this.#context ??= openContext());
    if (this.#face !== face) {
      this.#face = face;
      context.font = face.font;
      context.letterSpacing = `${String(face.letterSpacingPx)}px`;
      context.wordSpacing = `${String(face.wordSpacingPx)}px`;
    }
    return context;
  }
}

/** One ask being measured: where it has got to and what it has measured so far. */
interface PendingAsk {
  readonly labels: readonly LabelMeasureRequest[];
  readonly resolve: (measured: LabelMeasurements[]) => void;
  readonly measured: LabelMeasurements[];
  faceIndex: number;
  /** The current face's widths so far, in the order of its texts. */
  widths: number[];
}

/** The idle time, in milliseconds, below which measuring waits for the next idle moment. */
const IDLE_FLOOR_MS = 1;

/** How long an ask waits for idle time before a slice runs anyway, in milliseconds. */
const IDLE_WAIT_MS = 50;

/**
 * The most one slice measures, in milliseconds by the wall clock, idle grant or not: well inside a
 * frame.
 */
const SLICE_MS = 4;

function openContext(): OffscreenCanvasRenderingContext2D {
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  if (context === null) {
    throw new Error("This window cannot measure diagram labels.");
  }
  return context;
}
