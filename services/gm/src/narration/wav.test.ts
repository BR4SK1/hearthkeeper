import { describe, expect, it } from "vitest";
import { pcmDurationMs, wavDurationMs } from "./wav.js";

/** Build a minimal valid 16-bit PCM wav with the given sample count. */
function makeWav(sampleRate: number, channels: number, bitsPerSample: number, sampleCount: number): Uint8Array {
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
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true); // byte rate
  view.setUint16(32, channels * (bitsPerSample / 8), true); // block align
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

describe("wavDurationMs", () => {
  it("computes duration from a valid wav header (24kHz mono 16-bit, like the deployed TTS)", () => {
    const bytes = makeWav(24000, 1, 16, 24000); // exactly 1 second
    expect(wavDurationMs(bytes)).toBeCloseTo(1000, 0);
  });

  it("handles stereo and other rates", () => {
    const bytes = makeWav(44100, 2, 16, 22050); // 0.5s of stereo (22050 frames)
    expect(wavDurationMs(bytes)).toBeCloseTo(500, 0);
  });

  it("returns null on a truncated buffer", () => {
    const full = makeWav(24000, 1, 16, 2400);
    expect(wavDurationMs(full.subarray(0, 20))).toBeNull();
  });

  it("returns null on random bytes", () => {
    const random = new Uint8Array(512);
    crypto.getRandomValues(random);
    expect(wavDurationMs(random)).toBeNull();
  });
});

describe("pcmDurationMs vs header placeholder", () => {
  it("streamed placeholder header: pcm duration is correct, header duration is wrong", () => {
    // Build a truthful wav (2s), then LIE in the header like the deployed
    // streaming mode does (placeholder data-size) while the buffer keeps
    // all its PCM bytes.
    const real = makeWav(24000, 1, 16, 48000); // 2 seconds
    const placeholder = real.slice();
    const placeholderView = new DataView(placeholder.buffer);
    placeholderView.setUint32(40, 8, true); // deliberate placeholder data-size
    placeholderView.setUint32(4, 36 + 8, true); // matching RIFF size lie

    expect(pcmDurationMs(placeholder)).toBeCloseTo(2000, 0);
    expect(wavDurationMs(placeholder)).toBeCloseTo(8 / (24000 * 2) * 1000, 5); // header-derived, WRONG
    expect(wavDurationMs(placeholder)).not.toBeCloseTo(2000, 0); // documents the bug
  });

  it("header-correct wav: both flavors agree", () => {
    const bytes = makeWav(24000, 1, 16, 24000); // 1s, truthful header
    expect(pcmDurationMs(bytes)).toBeCloseTo(1000, 0);
    expect(wavDurationMs(bytes)).toBeCloseTo(1000, 0);
  });

  it("still returns null on malformed input", () => {
    expect(pcmDurationMs(new Uint8Array(20))).toBeNull();
    const random = new Uint8Array(512);
    crypto.getRandomValues(random);
    expect(pcmDurationMs(random)).toBeNull();
  });
});
