/**
 * RIFF/WAVE parsing helpers. Two duration flavors:
 * - wavDurationMs: header data-size based (correct for whole-utterance WAVs).
 * - pcmDurationMs: counts ACTUAL PCM bytes — streamed WAVs carry a
 *   placeholder data-size in their header, so pcmDurationMs is correct for
 *   both streamed (placeholder) and whole-utterance (correct) headers.
 * All parsers return null on malformed input — never throw.
 */

export interface WavPcmInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset where the data chunk payload begins. */
  dataStart: number;
  /** The data chunk size as declared in the header (may be a placeholder). */
  headerDataSize: number;
}

/** RIFF walk (word-aligned chunks); null when the structure is unusable. */
export function parseWavPcm(bytes: Uint8Array): WavPcmInfo | null {
  try {
    if (bytes.length < 12) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(...bytes.subarray(offset, offset + length));

    if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return null;

    let offset = 12;
    let sampleRate: number | null = null;
    let channels = 0;
    let bitsPerSample = 0;
    let dataStart = -1;
    let headerDataSize = 0;

    while (offset + 8 <= bytes.length) {
      const chunkId = ascii(offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkId === "fmt ") {
        if (offset + 8 + 16 > bytes.length) return null;
        channels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
      } else if (chunkId === "data") {
        dataStart = offset + 8;
        headerDataSize = chunkSize;
        break; // fmt must come first per spec; stop at the first data chunk
      }
      offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
    }

    if (dataStart === -1 || sampleRate === null || channels < 1 || bitsPerSample < 1 || sampleRate < 1) {
      return null;
    }
    return { sampleRate, channels, bitsPerSample, dataStart, headerDataSize };
  } catch {
    return null;
  }
}

/** Duration from the header's data-size — correct only when the header is truthful. */
export function wavDurationMs(bytes: Uint8Array): number | null {
  const info = parseWavPcm(bytes);
  if (info === null) return null;
  const bytesPerFrame = (info.channels * info.bitsPerSample) / 8;
  if (bytesPerFrame <= 0) return null;
  return (info.headerDataSize / (info.sampleRate * bytesPerFrame)) * 1000;
}

/**
 * Duration from ACTUAL PCM bytes: streamed WAVs carry a placeholder
 * data-size in the header, so the byte count after dataStart is the only
 * playback-truth source. Correct for both header flavors.
 */
export function pcmDurationMs(bytes: Uint8Array): number | null {
  const info = parseWavPcm(bytes);
  if (info === null) return null;
  const pcmBytes = bytes.length - info.dataStart;
  const bytesPerFrame = (info.channels * info.bitsPerSample) / 8;
  if (bytesPerFrame <= 0 || pcmBytes <= 0) return null;
  return (pcmBytes / (info.sampleRate * bytesPerFrame)) * 1000;
}