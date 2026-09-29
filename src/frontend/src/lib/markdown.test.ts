import { describe, expect, test } from "vitest";
import { renderMarkdown } from "./markdown.ts";

/**
 * `renderMarkdown` output goes into `{@html}`, so these are the whole safety
 * argument for the source panel (DESIGN-MODEL-IMPORT §7.5).
 */

function dom(markdown: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(markdown);
  return root;
}

describe("renderMarkdown", () => {
  test("renders what the server's HTML-to-Markdown step writes", () => {
    const root = dom(
      "# Title\n\nA **bold** and *em* line\nwith a break.\n\n- one\n- two\n\n" +
        "1. first\n\n`code` and\n\n```\nblock\n```",
    );
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("em");
    // One newline is a `<br>` on the way in, so it is one on the way out.
    expect(root.querySelector("p br")).not.toBeNull();
    expect(root.querySelectorAll("ul li").length).toBe(2);
    expect(root.querySelectorAll("ol li").length).toBe(1);
    expect(root.querySelector("pre code")?.textContent).toBe("block\n");
  });

  test("raw HTML is shown as text, block or inline", () => {
    const root = dom(
      "<script>alert(1)</script>\n\ninline <b onclick=x>b</b> " +
        '<iframe src="https://evil.example"></iframe>',
    );
    for (const tag of ["script", "b", "iframe"]) {
      expect(root.querySelector(tag)).toBeNull();
    }
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("<b onclick=x>b</b>");
  });

  test("links are http(s) only, and open somewhere else", () => {
    const root = dom(
      "[ok](https://civitai.red/models/1) [js](javascript:alert(1)) " +
        "[data](data:text/html,x) [rel](/api/config) <https://example.com>",
    );
    const links = [...root.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://civitai.red/models/1",
      "https://example.com",
    ]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
    // A refused link keeps its words.
    expect(root.textContent).toContain("js");
    expect(root.textContent).toContain("rel");
  });

  test("images are links, never requests", () => {
    const root = dom(
      "![a fox](https://image.civitai.com/x.png) ![](javascript:x) " +
        '<img src="https://image.civitai.com/y.png">',
    );
    expect(root.querySelector("img")).toBeNull();
    const links = [...root.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["a fox", "https://image.civitai.com/x.png"],
    ]);
  });

  test("attribute quoting cannot be broken out of", () => {
    const root = dom('[x](https://a.example/"onmouseover="alert(1))');
    const a = root.querySelector("a");
    expect(a?.getAttribute("onmouseover") ?? null).toBeNull();
  });
});
