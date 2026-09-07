// AI TOC runtime timing. PURE — no persistence, telemetry, React, or network.

export type AiTocTiming = {
  renderingMs: number
  transcriptionMs: number[]
  structureAttemptMs: number[]
  mappingMs: number
  totalMs: number
}

export function createAiTocTiming(): AiTocTiming {
  return {
    renderingMs: 0,
    transcriptionMs: [],
    structureAttemptMs: [],
    mappingMs: 0,
    totalMs: 0,
  }
}

/** Prefer the monotonic browser clock; keep the Node/test fallback dependency-free. */
export function aiTocNowMs(): number {
  const perf = typeof globalThis !== 'undefined' ? globalThis.performance : undefined
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
}

export function aiTocDurationMs(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0
  return Math.max(0, endMs - startMs)
}

export function elapsedAiTocMs(startMs: number): number {
  return aiTocDurationMs(startMs, aiTocNowMs())
}

/** Return a snapshot so callers cannot mutate the timing arrays owned by the run. */
export function finalizeAiTocTiming(timing: AiTocTiming, totalStartMs: number): AiTocTiming {
  return {
    renderingMs: timing.renderingMs,
    transcriptionMs: [...timing.transcriptionMs],
    structureAttemptMs: [...timing.structureAttemptMs],
    mappingMs: timing.mappingMs,
    totalMs: elapsedAiTocMs(totalStartMs),
  }
}
