/**
 * Somebody else's HTML, made safe and made plain
 * (DESIGN-MODEL-IMPORT §5.5, §7.5).
 *
 * A Civitai description is real HTML — measured across two popular models it
 * uses `h1`–`h3`, `p`, `br`, `strong`, `em`, `u`, `s`, `a`, `ul`, `li`,
 * `code`, `pre`, `span` and `img`, the output of a rich-text editor, six to
 * eight kilobytes of it. So it cannot be flattened to text without losing the
 * structure that makes it readable, and it cannot be rendered as it arrived.
 * Two functions, then: one that makes it plain for the API, and one that makes
 * it safe for the page.
 *
 * Both are deliberately small hand-written passes rather than a parser
 * dependency. The input is one well-known editor's output, the allowed set is
 * a dozen tags, and the failure mode that matters — a tag surviving that
 * should not have — is easier to reason about in fifty lines than behind
 * somebody's configuration object.
 */

/** Tags whose content survives sanitising. Everything else is unwrapped. */
const ALLOWED = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "a",
  "ul",
  "ol",
  "li",
  "code",
  "pre",
  "blockquote",
]);

/**
 * Tags whose *content* goes too, not just their markup. Unwrapping a
 * `<script>` would leave its source as visible text, which is worse than
 * either keeping or dropping it.
 */
const DROP_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "template",
  "noscript",
]);

const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link"]);

interface Token {
  kind: "text" | "tag";
  /** For a tag: its lower-case name. */
  name?: string;
  closing?: boolean;
  selfClosing?: boolean;
  attrs?: Record<string, string>;
  text?: string;
}

/**
 * Enough of a tokeniser for editor output: tags, attributes, text, comments.
 * A `<` that does not begin a tag is text, which is what a description
 * containing `a < b` needs.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text.length > 0) tokens.push({ kind: "text", text });
    text = "";
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      // A stray `<` with no `>` after it: text, not a broken tag.
      text += html.slice(lt);
      break;
    }
    const inner = html.slice(lt + 1, gt);
    const match = inner.match(/^\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)/);
    if (!match) {
      text += html.slice(lt, gt + 1);
      i = gt + 1;
      continue;
    }
    flush();
    tokens.push({
      kind: "tag",
      name: match[2]!.toLowerCase(),
      closing: match[1] === "/",
      selfClosing: inner.trimEnd().endsWith("/"),
      attrs: parseAttrs(inner.slice(match[0].length)),
    });
    i = gt + 1;
  }
  flush();
  return tokens;
}

/** The first `>` outside a quoted attribute value. */
function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < html.length; i++) {
    const char = html[i]!;
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return i;
  }
  return -1;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern =
    /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of source.matchAll(pattern)) {
    attrs[match[1]!.toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return attrs;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const code = body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeHref(value: string): string | null {
  const trimmed = decodeEntities(value).trim();
  // Anything that is not plainly http(s) is dropped rather than guessed at:
  // `javascript:`, `data:` and the whitespace-obfuscated spellings of both.
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * The page's copy: the allowed tags, no attributes but a checked `href`, and
 * **no images**.
 *
 * Dropping `<img>` is not tidiness. Those point at `image.civitai.com`, and
 * rendering them would make opening a model page issue requests to a third
 * party every time it is opened — in an app whose whole premise is that it
 * does not talk to anyone you did not ask it to (§4.6). The description's
 * images are decoration; the samples strip holds the ones that matter, and
 * those are on disk.
 */
export function sanitizeHtml(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let dropping: string | null = null;

  for (const token of tokenize(html)) {
    if (token.kind === "text") {
      if (dropping === null) out.push(escapeText(decodeEntities(token.text!)));
      continue;
    }
    const name = token.name!;
    if (dropping !== null) {
      if (token.closing && name === dropping) dropping = null;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!token.closing && !token.selfClosing) dropping = name;
      continue;
    }
    if (name === "img") {
      const src = safeHref(token.attrs?.src ?? "");
      const alt = token.attrs?.alt;
      if (src !== null) {
        const label = alt && alt.length > 0
          ? escapeText(decodeEntities(alt))
          : "image";
        out.push(`<a href="${escapeText(src)}" ${LINK_RELS}>${label}</a>`);
      }
      continue;
    }
    if (!ALLOWED.has(name)) continue; // unwrapped: content kept, markup gone

    if (VOID_TAGS.has(name)) {
      if (!token.closing) out.push(`<${name} />`);
      continue;
    }
    if (token.closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue; // a close with no open
      for (let i = open.length - 1; i >= at; i--) out.push(`</${open[i]}>`);
      open.length = at;
      continue;
    }
    if (name === "a") {
      const href = safeHref(token.attrs?.href ?? "");
      if (href === null) continue; // an anchor going nowhere is not a link
      out.push(`<a href="${escapeText(href)}" ${LINK_RELS}>`);
    } else {
      out.push(`<${name}>`);
    }
    open.push(name);
  }
  for (let i = open.length - 1; i >= 0; i--) out.push(`</${open[i]}>`);
  return out.join("");
}

const LINK_RELS = 'target="_blank" rel="noopener noreferrer nofollow"';

/**
 * The API's copy: Markdown. Headings become `#` lines, list items `-` lines,
 * links `[text](url)`, images vanish, and everything else is unwrapped.
 *
 * Markdown rather than bare text because the structure is most of what makes
 * a description readable, and because whatever reads this next — a model
 * page, an MCP tool result — already knows how to display it.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  const listStack: { ordered: boolean; index: number }[] = [];
  let link: string | null = null;
  let inPre = false;

  const push = (text: string) => out.push(text);
  const breakLine = () => {
    if (out.length > 0 && !out[out.length - 1]!.endsWith("\n")) push("\n");
  };
  const breakBlock = () => {
    breakLine();
    if (out.length > 0 && !out[out.length - 1]!.endsWith("\n\n")) push("\n");
  };

  for (const token of tokenize(html)) {
    if (token.kind === "text") {
      const decoded = decodeEntities(token.text!);
      push(inPre ? decoded : decoded.replace(/\s+/g, " "));
      continue;
    }
    const name = token.name!;
    if (DROP_CONTENT.has(name) || name === "img") {
      // Same reasoning as the sanitiser, plus: an image has no text.
      continue;
    }
    switch (name) {
      case "br":
        if (!token.closing) breakLine();
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4": {
        breakBlock();
        if (!token.closing) push(`${"#".repeat(Number(name[1]))} `);
        break;
      }
      case "p":
      case "blockquote":
        breakBlock();
        break;
      case "ul":
      case "ol":
        if (token.closing) listStack.pop();
        else listStack.push({ ordered: name === "ol", index: 0 });
        breakBlock();
        break;
      case "li": {
        if (token.closing) break;
        breakLine();
        const list = listStack[listStack.length - 1];
        const indent = "  ".repeat(Math.max(0, listStack.length - 1));
        if (list?.ordered) push(`${indent}${++list.index}. `);
        else push(`${indent}- `);
        break;
      }
      case "pre":
        if (token.closing) {
          inPre = false;
          push("\n```");
        } else {
          breakBlock();
          push("```\n");
          inPre = true;
        }
        break;
      case "code":
        if (!inPre) push("`");
        break;
      case "strong":
      case "b":
        push("**");
        break;
      case "em":
      case "i":
        push("*");
        break;
      case "a":
        if (token.closing) {
          if (link !== null) push(`](${link})`);
          link = null;
        } else {
          const href = safeHref(token.attrs?.href ?? "");
          if (href !== null) {
            link = href;
            push("[");
          }
        }
        break;
    }
  }

  return out.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
