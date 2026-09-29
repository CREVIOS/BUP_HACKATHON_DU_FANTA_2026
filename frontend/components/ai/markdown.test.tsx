import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/ai/markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("Markdown", () => {
  it("renders **bold** as <strong> and leaves the rest as text", () => {
    const out = html("**Ship 5,000 L** to STN-MIRPUR");
    expect(out).toMatch(/<strong[^>]*>Ship 5,000 L<\/strong>/);
    expect(out).toContain("to STN-MIRPUR");
  });

  it("renders a run of - / • lines as a bullet list", () => {
    const out = html("- risk 72% before\n- route R-1 chosen");
    expect(out).toContain("<ul");
    expect(count(out, "<li")).toBe(2);
    expect(out).toContain("route R-1 chosen");
  });

  it("keeps paragraphs separate and does not treat prose as a list", () => {
    const out = html("First line.\n\nSecond paragraph.");
    expect(count(out, "<p")).toBe(2);
    expect(out).not.toContain("<ul");
  });

  it("escapes raw HTML from the input (no injection)", () => {
    const out = html("<img src=x onerror=alert(1)> and **safe**");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toMatch(/<strong[^>]*>safe<\/strong>/);
  });
});
