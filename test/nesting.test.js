/** Nested and repeated delimiters: no stack overflow, and text that cannot be a group streams before the block end. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteStream } from "../lib/stream.js";
import { createTransducer, rewriteText } from "../lib/transducer.js";
import { randomChunks } from "./sessions.js";

const MARKER = " ⚠️(unverified)";
const sources = {
  1: { url: "https://a.example/one", title: "One" },
  2: { url: "https://b.example/two", title: "Two" },
};
const opts = { sources, seen: {}, marker: MARKER };
const L1 = "[S1](https://a.example/one)";
const L2 = "[S2](https://b.example/two)";
const NESTED = ["((x))", "[[x]]", "( (x", "[S1 [S2]]", "ver (a) y (( b ))", "(no push) more text"];

/** Stream `text` in `chunks` through rewriteStream; returns the deltas, the block end, and what came before it. */
async function stream(chunks, text) {
  async function* model() {
    for (const piece of chunks) yield { type: "text-delta", index: 0, text: piece };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
  }
  let deltas = "";
  let beforeEnd = "";
  let end;
  for await (const chunk of rewriteStream(model(), () => ({ sources, seen: {} }), MARKER)) {
    if (chunk.type === "text-delta") deltas += chunk.text;
    if (chunk.type === "block-end") {
      beforeEnd = deltas;
      end = chunk.block.text;
    }
  }
  return { deltas, end, beforeEnd };
}

for (const text of NESTED) {
  test(`${JSON.stringify(text)} does not throw, whole or streamed`, async () => {
    const whole = rewriteText(text, opts);
    for (const chunks of [[text], [...text], randomChunks(text, 7, 3)]) {
      const { deltas, end } = await stream(chunks, text);
      assert.equal(end, deltas);
      assert.equal(deltas, whole);
    }
  });
}

test("text that cannot become a group is emitted before the block end", () => {
  const t = createTransducer(opts);
  assert.equal(t.push("(no push) more text"), "(no push) more text");
  assert.equal(t.flush(), "");
  const u = createTransducer(opts);
  assert.equal(u.push("ver (a) y (( b ))"), "ver (a) y (( b ))");
  assert.equal(u.flush(), "");
});

test("streamed plain text reaches the deltas before the block end", async () => {
  const text = "(no push) more text";
  const { beforeEnd } = await stream([...text], text);
  assert.equal(beforeEnd, text);
});

test("nested delimiters keep their text when they hold no ids", () => {
  assert.equal(rewriteText("((x))", opts), "((x))");
  assert.equal(rewriteText("[[x]]", opts), "[[x]]");
  assert.equal(rewriteText("( (x", opts), "( (x");
});

test("a nested bracket group of ids becomes its links", () => {
  assert.equal(rewriteText("[S1 [S2]]", opts).split("\n\nFuentes:")[0], `${L1}, ${L2}`);
});

test("[S1] and (S1) citations are still rewritten, streamed or whole", async () => {
  const text = "see [S1] and (S1, S2).";
  const expected = `see ${L1} and (${L1}, ${L2}).\n\nFuentes:\n- [S1] One — https://a.example/one\n- [S2] Two — https://b.example/two`;
  assert.equal(rewriteText(text, opts), expected);
  const { deltas, end } = await stream([...text], text);
  assert.equal(end, expected);
  assert.equal(deltas, expected);
});

test("a partial `and` separator is held until the next chunk decides it", () => {
  const t = createTransducer(opts);
  assert.equal(t.push("x (S1 an"), "x ");
  assert.equal(t.push("d S2) y"), `(${L1} and ${L2}) y`);
});

test("deeply nested delimiters do not overflow the stack", () => {
  const text = `${"(".repeat(20000)}x${")".repeat(20000)}`;
  assert.equal(rewriteText(text, opts), text);
});
