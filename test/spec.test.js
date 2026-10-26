/** Citation-group specification on small inputs: separators, unknown ids, Fuentes order, stream guarantee. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CITE_LINE_TO, allocator, emptyState, labelContent } from "../lib/labels.js";
import { rewriteStream } from "../lib/stream.js";
import { createTransducer, rewriteText } from "../lib/transducer.js";
import { randomChunks } from "./sessions.js";

const MARKER = " ⚠️(unverified)";
const sources = {
  2: { url: "https://a.example/two", title: "Two" },
  6: { url: "https://b.example/six", title: "Six" },
};
const opts = { sources, seen: {}, marker: MARKER };
const body = (text) => rewriteText(text, opts).split("\n\nFuentes:")[0];
const L2 = "[S2](https://a.example/two)";
const L6 = "[S6](https://b.example/six)";

test("groups with every separator: comma, semicolon, space, y, and", () => {
  assert.equal(body("x (S2, S6)."), `x (${L2}, ${L6}).`);
  assert.equal(body("x (S2; S6)."), `x (${L2}; ${L6}).`);
  assert.equal(body("x (S2 S6)."), `x (${L2} ${L6}).`);
  assert.equal(body("x (S2 y S6)."), `x (${L2} y ${L6}).`);
  assert.equal(body("x (S2 and S6)."), `x (${L2} and ${L6}).`);
  assert.equal(body("x (S2S6) (hello) (S2."), "x (S2S6) (hello) (S2.");
});

test("bracket groups become the links themselves; parentheses are kept", () => {
  assert.equal(body("x [S2]."), `x ${L2}.`);
  assert.equal(body("x [S2, S6]."), `x ${L2}, ${L6}.`);
  assert.equal(body("x [S2][S6]."), `x ${L2}, ${L6}.`);
  assert.equal(body("x [S2] [S6]."), `x ${L2} ${L6}.`);
  assert.equal(body("x (S2)."), `x (${L2}).`);
  assert.equal(body("x [S9]."), "x S9 ⚠️(unknown source).");
});

test("text after a citation group streams without waiting for the block end", () => {
  const t = createTransducer(opts);
  assert.equal(t.push("a (S2) b [S6] c "), `a (${L2}) b ${L6} c `);
  assert.equal(t.flush(), "\n\nFuentes:\n- [S2] Two — https://a.example/two\n- [S6] Six — https://b.example/six");
});

test("an unknown id becomes `S9 ⚠️(unknown source)` and is left out of Fuentes", () => {
  assert.equal(rewriteText("x (S9).", opts), "x (S9 ⚠️(unknown source)).");
  assert.equal(rewriteText("x (S2, S9).", opts), `x (${L2}, S9 ⚠️(unknown source)).\n\nFuentes:\n- [S2] Two — https://a.example/two`);
});

test("Fuentes lists each cited id once, in first-citation order", () => {
  assert.equal(rewriteText("a (S6). b (S2, S6). c (S2).", opts),
    `a (${L6}). b (${L2}, ${L6}). c (${L2}).\n\nFuentes:\n- [S6] Six — https://b.example/six\n- [S2] Two — https://a.example/two`);
});

test("stream: the block end equals the concatenated emitted deltas, Fuentes included", async () => {
  const text = "a (S6). b (S2 y S6). c (S9).";
  async function* model() {
    for (const piece of randomChunks(text, 3, 4)) yield { type: "text-delta", index: 0, text: piece };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
  }
  let deltas = "";
  let end;
  for await (const chunk of rewriteStream(model(), () => ({ sources, seen: {} }), MARKER)) {
    if (chunk.type === "text-delta") deltas += chunk.text;
    if (chunk.type === "block-end") end = chunk.block.text;
  }
  assert.equal(end, deltas);
  assert.equal(end, rewriteText(text, opts));
  assert.match(end, /\n\nFuentes:\n- \[S6\] Six — https:\/\/b\.example\/six\n- \[S2\] Two — https:\/\/a\.example\/two$/);
});

test("the instruction line is the specified text and appears once per labeled result", () => {
  assert.equal(CITE_LINE_TO, "Cite sources as [S1] or [S2, S6]. Never type a URL yourself.");
  const alloc = allocator(emptyState());
  const content = [{ type: "text", text: "- [A](https://a.example/1)\n- [B](https://a.example/2)" }, { type: "text", text: "more" }];
  const once = labelContent(content, alloc.labelFor);
  const all = once.map((b) => b.text).join("\n");
  assert.equal(all.split(CITE_LINE_TO).length - 1, 1);
  const again = labelContent(once, allocator(emptyState()).labelFor);
  assert.equal(again.map((b) => b.text).join("\n").split(CITE_LINE_TO).length - 1, 1);
});
