/**
 * ComfyUI's refusal of a prompt, said in full.
 *
 * When `/prompt` refuses a graph, the top-level message is almost always
 * "Prompt outputs failed validation", which names nothing. The reasons are in
 * `node_errors`: one entry per failing node, each with its class and a list of
 * `{type, message, details, extra_info}`. This turns those into one line per
 * reason, naming the node, so the job's error message — what the Generate
 * panel shows, what `POST /api/jobs` answers and what the bridge hands an
 * agent — says what actually failed. The structured `node_errors` stays on
 * the job row as well.
 */

/** ComfyUI pastes whole option lists into `details`; a line stays readable. */
const DETAIL_MAX = 400;
/** A graph that is wrong everywhere still gets a message that fits a card. */
const LINES_MAX = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

/**
 * One line per reason ComfyUI gave, e.g.
 * `node "3" (KSampler): Value not in list: sampler_name: 'eulr' not in [...]`.
 * Anything not in the shape ComfyUI uses is skipped rather than guessed at.
 */
export function describeNodeErrors(nodeErrors: unknown): string[] {
  if (!isRecord(nodeErrors)) return [];
  const lines: string[] = [];
  for (const [id, entry] of Object.entries(nodeErrors)) {
    if (!isRecord(entry)) continue;
    const classType = typeof entry.class_type === "string" &&
        entry.class_type.length > 0
      ? ` (${entry.class_type})`
      : "";
    const at = `node "${id}"${classType}`;
    const reasons = Array.isArray(entry.errors) ? entry.errors : [];
    if (reasons.length === 0) {
      lines.push(`${at}: failed validation`);
      continue;
    }
    for (const reason of reasons) {
      if (!isRecord(reason)) continue;
      const message = typeof reason.message === "string" &&
          reason.message.length > 0
        ? reason.message
        : typeof reason.type === "string"
        ? reason.type
        : "failed validation";
      const extra = isRecord(reason.extra_info) ? reason.extra_info : {};
      const details = typeof reason.details === "string" &&
          reason.details.trim().length > 0
        ? reason.details
        : typeof extra.input_name === "string"
        ? extra.input_name
        : "";
      lines.push(
        details ? `${at}: ${message}: ${clip(details)}` : `${at}: ${message}`,
      );
    }
  }
  if (lines.length > LINES_MAX) {
    const more = lines.length - LINES_MAX;
    return [...lines.slice(0, LINES_MAX), `… and ${more} more`];
  }
  return lines;
}

/** The top-level message with every node's reasons under it. */
export function withNodeErrors(message: string, nodeErrors: unknown): string {
  const lines = describeNodeErrors(nodeErrors);
  if (lines.length === 0) return message;
  return `${message}:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
