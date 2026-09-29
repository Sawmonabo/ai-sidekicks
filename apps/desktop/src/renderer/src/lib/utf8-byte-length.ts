// The one byte measurement every cap in the renderer counts through.

/**
 * The encoder the measurement below runs on. Stateless, so one serves every caller
 * rather than one being minted per call — which is what a second implementation did.
 */
const UTF8_ENCODER = new TextEncoder();

/**
 * How many bytes a string occupies once encoded, for every cap in this console.
 *
 * The chokepoint rule in `apps/desktop/AGENTS.md`: one byte-measurement function serves
 * every cap. It is published rather than module-private because a second cap now exists —
 * the run controls bound a cancellation reason exactly as the engine bounds a park cause
 * — and the two measured the same sentence through two functions until this line. They
 * agreed on ASCII, which is the whole hazard: the first surrogate-pair or normalisation
 * rule either of them grew would have moved one cap and not the other.
 *
 * UTF-8 bytes rather than `String.length`, which counts UTF-16 code units — a cap
 * counted in code units refuses a shorter sentence in one script than in another.
 */
export function measureUtf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}
