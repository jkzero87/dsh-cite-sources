/**
 * Code regions — fenced ``` ... ``` blocks, inline `...` spans, and `> ` quoted
 * log lines — pass through the transducer byte-for-byte: no URL decisions, no
 * citation-group expansion, no markers — while the surrounding prose keeps the
 * usual rules.
 *
 * The two real-session cases (f0475fd2 seq 352 and 3fe836a7 seq 240) reproduce
 * the pre-fix bug: their recorded answers show URLs inside fenced logs marked
 * with ⚠️(unverified) (seq 352 line 77, seq 240 the `BASE="..."` line).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransducer, rewriteText } from "../lib/transducer.js";
import { randomChunks, readEvents, replayLabels, sessionPath } from "./sessions.js";

const MARKER = " ⚠️(unverified)";
const track = (decisions) => (d) => decisions.push(d);
const noDecisionOpts = (decisions) => ({ sources: {}, seen: {}, marker: MARKER, onDecision: track(decisions) });

test("fenced block passes through; prose URLs around it are still decided", () => {
  const decisions = [];
  const out = rewriteText("Install it:\n```bash\nA http://x.example/y\n```\nDocs: http://z.example/w\n", noDecisionOpts(decisions));
  assert.equal(out, "Install it:\n```bash\nA http://x.example/y\n```\nDocs: http://z.example/w ⚠️(unverified)\n");
  assert.deepEqual(decisions.map((d) => [d.kind, d.input]), [["url", "http://z.example/w"]]);
});

test("fence pass-through also holds when URLs appear in surrounding chunks", () => {
  const decisions = [];
  const t = createTransducer(noDecisionOpts(decisions));
  let out = "";
  for (const chunk of ["http://a.example/x ", "\n```bash", "\nurl http://b.example/y\n```\n", "end"]) out += t.push(chunk);
  out += t.flush();
  assert.equal(out, "http://a.example/x ⚠️(unverified) \n```bash\nurl http://b.example/y\n```\nend");
  assert.deepEqual(decisions.map((d) => d.input), ["http://a.example/x"]);
});

test("inline code span passes through; prose after the span is still decided", () => {
  const decisions = [];
  const out = rewriteText("Run `curl http://a.example/b` now http://c.example/d", noDecisionOpts(decisions));
  assert.equal(out, "Run `curl http://a.example/b` now http://c.example/d ⚠️(unverified)");
  assert.deepEqual(decisions.map((d) => d.input), ["http://c.example/d"]);
});

test("quoted log lines pass through; following lines are still decided", () => {
  const decisions = [];
  const out = rewriteText("> log 2026-11-23 http://a.example/b\nnext http://c.example/d", noDecisionOpts(decisions));
  assert.equal(out, "> log 2026-11-23 http://a.example/b\nnext http://c.example/d ⚠️(unverified)");
  assert.deepEqual(decisions.map((d) => d.input), ["http://c.example/d"]);
});

test("a bare > (no space) is not a quoted line", () => {
  const decisions = [];
  const out = rewriteText(">http://a.example/b", noDecisionOpts(decisions));
  assert.equal(out, ">http://a.example/b ⚠️(unverified)");
});

test("backticks mid-line stay literal and do not open a code region", () => {
  const decisions = [];
  const out = rewriteText("a ` b http://a.example/b\n```", noDecisionOpts(decisions));
  assert.equal(out, "a ` b http://a.example/b ⚠️(unverified)\n```");
});

test("unclosed fence at block end passes through to the end", () => {
  const decisions = [];
  const out = rewriteText("before\n```\ncode http://a.example/b\ncode2 http://c.example/d", noDecisionOpts(decisions));
  assert.equal(out, "before\n```\ncode http://a.example/b\ncode2 http://c.example/d");
  assert.equal(decisions.length, 0);
});

test("citation group inside a fence is not expanded and adds no Fuentes", () => {
  const sources = { 1: { url: "https://x.example/one", title: "Uno" } };
  const decisions = [];
  const out = rewriteText("```\nsee (S1) here\n```", { sources, seen: {}, marker: MARKER, onDecision: track(decisions) });
  assert.equal(out, "```\nsee (S1) here\n```");
  assert.equal(decisions.length, 0);
});

test("citation group right after a closing fence is still expanded", () => {
  const sources = { 1: { url: "https://x.example/one", title: "Uno" } };
  const decisions = [];
  const out = rewriteText("```\nfoo\n```\n(sic) see [S1]", { sources, seen: {}, marker: MARKER, onDecision: track(decisions) });
  assert.equal(out, "```\nfoo\n```\n(sic) see [S1](https://x.example/one)\n\nFuentes:\n- [S1] Uno — https://x.example/one");
  assert.deepEqual(decisions.map((d) => [d.kind, d.input]), [["label", "S1"]]);
});

const CODE_TEXTS = [
  "Install:\n```bash\ncurl http://a.example/b\n```\nDocs http://c.example/d\n",
  "Run `curl http://a.example/b` then http://c.example/d",
  "> log http://a.example/b\nthen http://c.example/d\n",
  "before\n```\nafter http://a.example/b",
];

test("chunk independence over all code-region shapes", () => {
  for (const text of CODE_TEXTS) {
    const expected = rewriteText(text, noDecisionOpts([]));
    const one = createTransducer(noDecisionOpts([]));
    let acc = "";
    for (const ch of text) acc += one.push(ch);
    acc += one.flush();
    assert.equal(acc, expected, `1-char chunks for ${JSON.stringify(text)}`);
    for (const seed of [1, 2, 3]) {
      const t = createTransducer(noDecisionOpts([]));
      let acc2 = "";
      for (const chunk of randomChunks(text, seed)) acc2 += t.push(chunk);
      acc2 += t.flush();
      assert.equal(acc2, expected, `random chunks seed ${seed} for ${JSON.stringify(text)}`);
    }
  }
});

// --- real sessions (read-only from the sessions store) -----------------------

function replayBefore(sidPrefix, seq) {
  const events = readEvents(sessionPath(sidPrefix));
  const e = events.find((x) => x.seq === seq);
  assert.ok(e, `${sidPrefix} has no event seq ${seq}`);
  const text = (e.data.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const { state } = replayLabels(events.filter((x) => x.seq < seq));
  return { text, state };
}

test("f0475fd2 seq 352: every URL sits inside a fenced block — all pass through", () => {
  const { text, state } = replayBefore("f0475fd2", 352);
  const decisions = [];
  const out = rewriteText(text, { sources: state.sources, seen: state.seen, marker: MARKER, onDecision: track(decisions) });
  assert.equal(out, text); // verbatim: no marker, no expansion, no Fuentes block
  assert.equal(decisions.length, 0);
});

test("3fe836a7 seq 240: code-region URLs untouched, prose PR URL still decided", () => {
  const { text, state } = replayBefore("3fe836a7", 240);
  const decisions = [];
  const out = rewriteText(text, { sources: state.sources, seen: state.seen, marker: MARKER, onDecision: track(decisions) });
  const pr = "https://github.com/jkzero87/jira-rag/pull/4";
  for (const u of ["https://github.com/jkzero87/jira-rag", "http://host.docker.internal:8092/v1/chat/completions", "http://127.0.0.1:8000"]) {
    assert.ok(!decisions.some((d) => d.kind === "url" && d.input === u), `${u} was decided inside code`);
  }
  assert.ok(out.includes('BASE="http://127.0.0.1:8000 ⚠️(unverified)"'), "recorded line must stay verbatim");
  assert.deepEqual(decisions.map((d) => [d.kind, d.input]), [["url", pr]]);
  assert.ok(out.includes(pr));
});

test("chunk independence over both real fixtures", () => {
  for (const [sid, seq] of [["f0475fd2", 352], ["3fe836a7", 240]]) {
    const { text, state } = replayBefore(sid, seq);
    const expected = rewriteText(text, { sources: state.sources, seen: state.seen, marker: MARKER });
    const one = createTransducer({ sources: state.sources, seen: state.seen, marker: MARKER });
    let acc = "";
    for (const ch of text) acc += one.push(ch);
    acc += one.flush();
    assert.equal(acc, expected, `${sid} 1-char chunks`);
    for (const seed of [5, 7]) {
      const t = createTransducer({ sources: state.sources, seen: state.seen, marker: MARKER });
      let acc2 = "";
      for (const chunk of randomChunks(text, seed)) acc2 += t.push(chunk);
      acc2 += t.flush();
      assert.equal(acc2, expected, `${sid} random chunks seed ${seed}`);
    }
  }
});
