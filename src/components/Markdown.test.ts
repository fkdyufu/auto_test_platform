import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test("replies render headings, tables and code, and a table scrolls inside its own box", () => {
  const html = render("## 结论\n\n| 端口 | VLAN |\n|---|---|\n| 9 | 181 |\n\n```\nshow vrrp\n```");
  assert.match(html, /<h2>结论<\/h2>/);
  assert.match(html, /<div class="markdown-table"><table>.*<td>9<\/td>.*<\/table><\/div>/s);
  assert.match(html, /<pre><code>show vrrp\n<\/code><\/pre>/);
});

test("ranges written with one tilde stay plain text; two tildes strike through", () => {
  const html = render("端口 1~3 和 5~6，~~旧值~~");
  assert.match(html, /端口 1~3 和 5~6/);
  assert.match(html, /<del>旧值<\/del>/);
});

test("HTML and script links in a reply are not rendered", () => {
  const html = render("<script>alert(1)</script> <b>粗</b>\n\n[坏](javascript:alert(1)) [好](https://example.com)");
  assert.doesNotMatch(html, /<script|<b>|javascript:/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noreferrer">好<\/a>/);
});
