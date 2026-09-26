/**
 * Shared test helper: build a minimal valid 16-bit PCM wav byte buffer.
 * (Placed in a testutil module so pipeline and route tests can share the
 * builder with wav.test.ts without importing across test files.)
 */
export function makeWavBytes(
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  sampleCount: number,
): Uint8Array {
  const dataBytes = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new Uint8Array(44 + dataBytes);
  const view = new DataView(buffer.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}
