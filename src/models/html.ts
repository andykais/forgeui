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

// Emphasis is written as placeholders and settled at the end, because whether
// `**` means bold depends on what ends up either side of it.
const STRONG_OPEN = "\uE001";
const STRONG_CLOSE = "\uE002";
const EM_OPEN = "\uE003";
const EM_CLOSE = "\uE004";

/**
 * Markdown only reads `**` as bold when it hugs the text: `**PS: **the` and
 * `** (CPU is slow).**` are literal asterisks. Civitai's editor writes exactly
 * that — `<strong>PS: </strong>the` — all the time, so the whitespace moves
 * outside the markers, and a pair left holding nothing goes.
 */
function settleEmphasis(text: string): string {
  let settled = text;
  for (;;) {
    const next = settled
      .replace(/([\uE001\uE003])(\s+)/g, "$2$1")
      .replace(/(\s+)([\uE002\uE004])/g, "$2$1")
      .replace(/\uE001\uE002|\uE003\uE004/g, "");
    if (next === settled) break;
    settled = next;
  }
  return settled
    .replace(/[\uE001\uE002]/g, "**")
    .replace(/[\uE003\uE004]/g, "*");
}

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
  // Real editor output nests a paragraph inside every list item
  // (`<ul><li><p>text</p></li></ul>`). Breaking on that `<p>` would leave the
  // bullet alone on its own line, which is what it did before this existed.
  let justMarked = false;
  let listDepth = 0;

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
      // The placeholders below are private-use characters; one arriving in
      // the text itself would otherwise turn into asterisks.
      const decoded = decodeEntities(token.text!).replace(
        /[\uE001-\uE004]/g,
        "",
      );
      // Whitespace between `<li>` and its `<p>` is not content, and must not
      // clear the marker flag.
      if (justMarked && decoded.trim().length === 0) continue;
      push(inPre ? decoded : decoded.replace(/\s+/g, " "));
      if (decoded.trim().length > 0) justMarked = false;
      continue;
    }
    const name = token.name!;
    if (DROP_CONTENT.has(name) || name === "img") {
      // Same reasoning as the sanitiser, plus: an image has no text.
      continue;
    }
    const wasMarked = justMarked;
    justMarked = false;
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
        if (wasMarked && !token.closing) break;
        // Inside a list, a paragraph is the item's text, not a block of its
        // own: breaking twice would space every bullet apart.
        if (listDepth > 0) breakLine();
        else breakBlock();
        break;
      case "ul":
      case "ol":
        if (token.closing) {
          listStack.pop();
          listDepth--;
        } else {
          listStack.push({ ordered: name === "ol", index: 0 });
          listDepth++;
        }
        breakBlock();
        break;
      case "li": {
        if (token.closing) break;
        breakLine();
        const list = listStack[listStack.length - 1];
        const indent = "  ".repeat(Math.max(0, listStack.length - 1));
        if (list?.ordered) push(`${indent}${++list.index}. `);
        else push(`${indent}- `);
        justMarked = true;
        continue; // the flag must survive to the next token
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
        push(token.closing ? STRONG_CLOSE : STRONG_OPEN);
        break;
      case "em":
      case "i":
        push(token.closing ? EM_CLOSE : EM_OPEN);
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

  return settleEmphasis(out.join(""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A README that is already Markdown, with the HTML inside it turned into
 * Markdown too (DESIGN-MODEL-IMPORT §4.5).
 *
 * Hugging Face model cards are Markdown with HTML mixed in — a centred
 * `<h1 align="center">`, a row of `<img>` badges, a `<details>` block — and
 * the page's renderer shows raw HTML as text, which is correct for safety and
 * ugly for these. So the HTML goes here, the way `htmlToText` does it:
 * headings stay headings, links stay links, images become links, and
 * everything else is unwrapped. Code is left exactly as written, because
 * `<think>` in a code fence is an example, not markup.
 *
 * `resolve` turns the card's relative links into absolute ones, since a
 * relative link means "in this repo" and the page is not in this repo.
 */
export function markdownWithoutHtml(
  markdown: string,
  resolve: (path: string, image: boolean) => string | null = () => null,
): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;

  const flushProse = () => {
    if (prose.length > 0) out.push(proseWithoutHtml(prose.join("\n"), resolve));
    prose = [];
  };

  for (const line of lines) {
    const opener = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence === null && opener) {
      flushProse();
      fence = opener[1]!;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function proseWithoutHtml(
  text: string,
  resolve: (path: string, image: boolean) => string | null,
): string {
  // Inline code spans are kept whole, as the fences are, and so are
  // autolinks: `<https://…>` is Markdown, and would read as a tag named
  // `https`.
  return text.split(/(`+[^`]*`+|<[a-z][a-z0-9+.-]*:[^\s<>]*>)/i).map((
    part,
    at,
  ) => at % 2 === 1 ? part : relativeLinks(htmlInMarkdown(part), resolve))
    .join("");
}

function htmlInMarkdown(text: string): string {
  if (!text.includes("<")) return text;
  const out: string[] = [];
  let link: string | null = null;
  let dropping: string | null = null;

  for (const token of tokenize(text)) {
    if (dropping !== null) {
      if (token.kind === "tag" && token.closing && token.name === dropping) {
        dropping = null;
      }
      continue;
    }
    if (token.kind === "text") {
      // Verbatim: this is Markdown, and its own renderer decodes entities.
      out.push(token.text!);
      continue;
    }
    const name = token.name!;
    if (DROP_CONTENT.has(name)) {
      if (!token.closing && !token.selfClosing) dropping = name;
      continue;
    }
    switch (name) {
      case "br":
        out.push("\n");
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        out.push(
          token.closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `,
        );
        break;
      case "p":
      case "div":
      case "details":
      case "table":
      case "center":
        out.push("\n\n");
        break;
      case "summary":
        out.push(token.closing ? "**\n\n" : "\n\n**");
        break;
      case "tr":
        if (token.closing) out.push("\n");
        break;
      case "td":
      case "th":
        if (token.closing) out.push(" ");
        break;
      case "li":
        if (!token.closing) out.push("\n- ");
        break;
      case "strong":
      case "b":
        out.push("**");
        break;
      case "em":
      case "i":
        out.push("*");
        break;
      case "code":
        out.push("`");
        break;
      case "img": {
        // Never an image: a link to it, like everywhere else on this page.
        const src = token.attrs?.src ?? "";
        const alt = (token.attrs?.alt ?? "").trim() || "image";
        // Markdown's image, which the page renders as a link; kept an image
        // here so a relative `src` resolves to the file, not its web page.
        out.push(src.length > 0 ? `![${alt}](${src})` : "");
        break;
      }
      case "a":
        if (token.closing) {
          if (link !== null) out.push(`](${link})`);
          link = null;
        } else {
          const href = (token.attrs?.href ?? "").trim();
          if (href.length > 0) {
            link = href;
            out.push("[");
          }
        }
        break;
    }
  }
  return out.join("");
}

/** `[text](path)` and `![alt](path)` with a relative path, made absolute. */
function relativeLinks(
  text: string,
  resolve: (path: string, image: boolean) => string | null,
): string {
  return text.replace(
    /(!?)\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g,
    (whole, bang: string, label: string, target: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
        return whole;
      }
      const absolute = resolve(target, bang === "!");
      return absolute === null ? whole : `${bang}[${label}](${absolute})`;
    },
  );
}
