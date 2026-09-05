/**
 * The app's preview frame layout (§5 step 6): event, format, the job id's
 * length, the job id, then the image.
 */
export interface PreviewFrame {
  jobId: string;
  format: number;
  image: Uint8Array;
}

export function decodePreviewFrame(frame: Uint8Array): PreviewFrame | null {
  if (frame.length < 12) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0) !== 1) return null;
  const format = view.getUint32(4);
  const idLength = view.getUint32(8);
  if (frame.length < 12 + idLength) return null;
  return {
    jobId: new TextDecoder().decode(frame.subarray(12, 12 + idLength)),
    format,
    image: frame.subarray(12 + idLength),
  };
}
