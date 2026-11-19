import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import type { Job } from "../types.ts";

/**
 * A running job's card can stop it: Cancel asks the server to interrupt, and
 * the card says it is cancelling until ComfyUI confirms — the job only turns
 * cancelled when the interrupt lands.
 */

// A plain stub rather than vi.fn(): the spy keeps its own handle on each
// returned promise, and a rejected one then reads as unhandled even though the
// card catches it.
let cancelled: string[] = [];
let answer: (id: string) => Promise<void> = async () => {};
vi.mock("../api.ts", () => ({
  api: {
    cancelJob: (id: string) => {
      cancelled.push(id);
      return answer(id);
    },
  },
}));
vi.mock("../stores/app.svelte.ts", () => ({ app: { previews: {} } }));
vi.mock("../stores/panel.svelte.ts", () => ({ panel: {} }));

const { default: JobCard } = await import("./JobCard.svelte");

function job(extra: Partial<Job> = {}): Job {
  return {
    id: "01JRUN",
    prompt_id: "p-1",
    workflow_id: "sd15",
    workflow_hash: "h",
    status: "running",
    params: { seed: 7 },
    api_graph: {},
    progress: {
      pct: 40,
      eta_ms: 3000,
      node_id: "3",
      node_label: "KSampler",
      node_index: 2,
      node_total: 5,
      step: 8,
      max: 20,
    } as Job["progress"],
    error: null,
    template: null,
    created_at: 1_789_000_000_000,
    started_at: 1_789_000_000_000,
    finished_at: null,
    outputs: [],
    ...extra,
  };
}

beforeEach(() => {
  cancelled = [];
  answer = async () => {};
});

describe("a running job card", () => {
  test("Cancel interrupts the job and then says it is cancelling", async () => {
    let settle!: () => void;
    answer = () => new Promise<void>((resolve) => (settle = resolve));
    render(JobCard, { job: job() });

    const button = screen.getByRole("button", { name: "Cancel" });
    await fireEvent.click(button);
    expect(cancelled).toEqual(["01JRUN"]);
    expect(button.textContent?.trim()).toBe("Cancelling…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    settle();
  });

  test("a refused cancel gives the button back", async () => {
    answer = async () => {
      throw new Error("offline");
    };
    render(JobCard, { job: job() });
    const button = screen.getByRole("button", { name: "Cancel" });
    await fireEvent.click(button);
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(button.textContent?.trim()).toBe("Cancel");
  });
});
