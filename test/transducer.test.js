/** Test 1: streaming transducer over real final answers, random chunkings, several seeds. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteStream } from "../lib/stream.js";
import { rewriteText } from "../lib/transducer.js";
import { finalAnswers, randomChunks, readEvents, replayLabels, sessionPath } from "./sessions.js";

const SESSIONS = ["2516f527", "caf6378d", "f0d2a1d6", "ed68c8f7", "1dd30925"];
const SEEDS = [1, 2, 3, 7, 42, 1234, 99991, 2026];
const MARKER = " ⚠️(unverified)";

async function collect(chunks, state) {
  async function* upstream() {
    yield { type: "block-start", index: 0, blockType: "text" };
    for (const text of chunks) yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text: chunks.join("") } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  let deltas = "";
  let ended;
  for await (const chunk of rewriteStream(upstream(), () => state, MARKER)) {
    if (chunk.type === "text-delta") deltas += chunk.text;
    if (chunk.type === "block-end") ended = chunk.block.text;
  }
  return { deltas, ended };
}

for (const sid of SESSIONS) {
  test(`transducer is chunking-independent on real answers of ${sid}`, async () => {
    const events = readEvents(sessionPath(sid));
    const { state } = replayLabels(events);
    const answers = [...finalAnswers(events)];
    assert.ok(answers.length > 0);
    for (const [turn, text] of answers) {
      const whole = rewriteText(text, { sources: state.sources, seen: state.seen, marker: MARKER });
      for (const seed of SEEDS) {
        const chunks = randomChunks(text, seed);
        const { deltas, ended } = await collect(chunks, state);
        assert.equal(ended, deltas, `${sid} turn ${turn} seed ${seed}: block-end != deltas`);
        assert.equal(deltas, whole, `${sid} turn ${turn} seed ${seed}: output depends on chunking`);
      }
      const single = await collect([...text], state);
      assert.equal(single.deltas, whole, `${sid} turn ${turn}: one-char chunks differ`);
      console.log(`${sid} turn ${turn}: ${text.length} chars in, ${whole.length} out, ${SEEDS.length} seeds + 1-char chunking identical`);
    }
  });
}

test("a block end that disagrees with its deltas is rejected", async () => {
  async function* upstream() {
    yield { type: "text-delta", index: 0, text: "abc" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "abd" } };
  }
  await assert.rejects(async () => {
    for await (const _ of rewriteStream(upstream(), () => ({ sources: {}, seen: [] }), MARKER));
  }, /differs from its streamed deltas/);
});

test("reasoning and tool-call chunks pass through unchanged", async () => {
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "see https://never-seen.example/x [S9]" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "see https://never-seen.example/x [S9]" } },
    { type: "tool-call-delta", index: 1, id: "c1", name: "web_fetch", argumentsDelta: '{"url":"https://never-seen.example/x"}' },
  ];
  async function* upstream() { yield* chunks; }
  const out = [];
  for await (const c of rewriteStream(upstream(), () => ({ sources: {}, seen: [] }), MARKER)) out.push(c);
  assert.deepEqual(out, chunks);
});

test("path-prefix rule: verified only at a '/' boundary, same host, no query", async () => {
  const { isVerifiedUrl } = await import("../lib/transducer.js");
  const seen = new Set(["github.com/switchbrew/nx-hbmenu/releases/tag/v3.6.1"]);
  assert.equal(isVerifiedUrl("https://github.com/switchbrew/nx-hbmenu", seen), true);
  assert.equal(isVerifiedUrl("https://github.com/switchbrew/nx-hbmenu/", seen), true);
  assert.equal(isVerifiedUrl("https://github.com/switchbrew/nx-hb", seen), false);
  assert.equal(isVerifiedUrl("https://github.com/switchbrew/nx-hbmenu?tab=readme", seen), false);
  assert.equal(isVerifiedUrl("https://gitlab.com/switchbrew/nx-hbmenu", seen), false);
});
