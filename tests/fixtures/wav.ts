/**
 * Real WAV bytes, for wherever a test needs audio that ffprobe will actually
 * read (DESIGN-AUDIO §2.2).
 *
 * The fake ComfyUI writes one of these where a save-audio node would, in the
 * same spirit as `tinyPng`: small, deterministic, and genuinely the format it
 * claims to be — a header the app believes and bytes ffmpeg cannot parse is
 * the shape of every audio bug worth catching.
 */

export interface TinyWavOptions {
  seconds?: number;
  /** A tone, so the drawn waveform has a shape rather than a flat line. */
  hz?: number;
  sampleRate?: number;
  /** 0–1. Silence in the middle third, so the picture shows the gap. */
  amplitude?: number;
}

export function tinyWav(options: TinyWavOptions = {}): Uint8Array {
  const seconds = options.seconds ?? 1;
  const hz = options.hz ?? 440;
  const sampleRate = options.sampleRate ?? 8000;
  const amplitude = options.amplitude ?? 0.8;
  const frames = Math.max(1, Math.round(seconds * sampleRate));

  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);

  for (let i = 0; i < frames; i++) {
    const third = i / frames;
    const quiet = third > 0.4 && third < 0.6;
    const value = quiet
      ? 0
      : Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * 0x7fff;
    view.setInt16(44 + i * 2, Math.round(value), true);
  }
  return bytes;
}
