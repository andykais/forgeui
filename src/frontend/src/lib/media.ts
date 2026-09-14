/**
 * What a media URL is, when nothing else says.
 *
 * A thumbnail is often just a path — a model's `thumb_url`, a sample's media —
 * with no `kind` beside it, and pointing an `<img>` at an mp4 draws the
 * browser's broken-image outline rather than the video. The extension is what
 * the server filed it under (`jobs/completion.ts`), so it is the same answer
 * read from the other end.
 */
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mkv", ".mov"];

export function isVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  // Query and fragment are ours (`#t=` seeks a poster frame), not the name.
  const path = url.split(/[?#]/)[0] ?? "";
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

/**
 * A video element shows nothing until it has decoded a frame, and
 * `preload="metadata"` alone often leaves a black plate. Seeking a fraction
 * of a second in gives the browser a frame to paint, which is what makes a
 * still thumbnail out of a video.
 */
export function posterFrame(url: string): string {
  return url.includes("#") ? url : `${url}#t=0.1`;
}

/**
 * A value that is a file in the content-addressed input store (§9), and the
 * URL it is served from.
 *
 * An `image` param holds `<sha256>.<ext>` and nothing else does, so the shape
 * of the value is enough to recognise one — the same test the server applies
 * when it decides what to upload (`jobs/pipeline.ts`). That matters where the
 * manifest is not to hand: the metadata sidebar has an output's params but
 * not the types behind them, and a 64-character hash is no use to anybody as
 * a line of text.
 */
const INPUT_FILENAME = /^([0-9a-f]{64})\.(png|jpe?g|webp)$/;

export function inputMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || !INPUT_FILENAME.test(value)) return null;
  return `/api/media/inputs/${value.slice(0, 2)}/${value}`;
}
