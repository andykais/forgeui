import { api } from "../api.ts";
import type { Output } from "../types.ts";

/**
 * Delete has no confirmation: the item disappears and an undo toast restores
 * it (§11.2). The window comes from the server, which is also what schedules
 * the files for removal.
 */
export interface Toast {
  id: string;
  message: string;
  /** Present while the deletion can still be taken back. */
  undo?: () => void;
  timer: ReturnType<typeof setTimeout>;
}

class ToastState {
  items = $state<Toast[]>([]);

  undo(output: Output, windowMs: number): void {
    const id = `delete:${output.id}`;
    this.#push({
      id,
      message: `Deleted ${output.id.slice(-7)}`,
      undo: async () => {
        this.dismiss(id);
        await api.restoreOutput(output.id).catch((cause) => {
          this.message(cause instanceof Error ? cause.message : "could not restore it");
        });
      },
      windowMs,
    });
  }

  message(text: string, windowMs = 5000): void {
    this.#push({ id: `message:${Date.now()}`, message: text, windowMs });
  }

  dismiss(id: string): void {
    const toast = this.items.find((item) => item.id === id);
    if (toast) clearTimeout(toast.timer);
    this.items = this.items.filter((item) => item.id !== id);
  }

  #push(init: {
    id: string;
    message: string;
    undo?: () => void;
    windowMs: number;
  }): void {
    this.dismiss(init.id);
    const timer = setTimeout(() => this.dismiss(init.id), init.windowMs);
    this.items = [
      ...this.items,
      {
        id: init.id,
        message: init.message,
        undo: init.undo,
        timer,
      },
    ];
  }
}

export const toasts = new ToastState();
