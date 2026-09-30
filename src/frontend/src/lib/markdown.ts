import { Marked, type Tokens } from "marked";

/**
 * Markdown a stranger wrote, as markup this page can hold
 * (DESIGN-MODEL-IMPORT §7.5).
 *
 * `marked` does not sanitise, so the rules the server's HTML sanitiser keeps
 * are kept here, in the renderer, where every piece of output is made:
 *
 * - **Raw HTML is text.** A description is Markdown the server derived at
 *   ingest, but an entity-decoded `&lt;script&gt;` in it reads as a tag, and
 *   Markdown passes tags through. Here they are escaped and shown.
 * - **Links are `http(s):` only**, opened elsewhere and carrying nothing of
 *   ours. Anything else — `javascript:`, `data:`, a relative path that would
 *   resolve against this app — keeps its text and loses the link.
 * - **No image is loaded.** Each becomes a plain link to where it lives, so
 *   opening a model page never calls a third party.
 *
 * Its own instance rather than the global `marked`, so nothing else that
 * imports the library inherits these rules or can undo them.
 */

const OPENS_ELSEWHERE = 'target="_blank" rel="noopener noreferrer nofollow"';

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

const renderer = new Marked({
  gfm: true,
  // The server writes a `<br>` as one newline; without this it would fold
  // into the line before it.
  breaks: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link(token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      if (href === null) return text;
      return `<a href="${escapeHtml(href)}" ${OPENS_ELSEWHERE}>${text}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      const label = escapeHtml(text.trim() || "image");
      const safe = safeHref(href);
      if (safe === null) return label;
      return `<a href="${escapeHtml(safe)}" ${OPENS_ELSEWHERE}>${label}</a>`;
    },
  },
});

export function renderMarkdown(source: string): string {
  return renderer.parse(source) as string;
}
