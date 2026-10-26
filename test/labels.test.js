/** Fix 3: one real result per labeled tool, before/after, with the citation line exactly once. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CITE_LINE_FROM, CITE_LINE_TO, allocator, emptyState, labelContent } from "../lib/labels.js";
import { readEvents, SESSIONS_ROOT } from "./sessions.js";

/** First successful result of `tool` with at least one source line, scanning sessions newest first. */
function firstRealResult(tool) {
  const files = fs.readdirSync(SESSIONS_ROOT).flatMap((dir) => fs.readdirSync(path.join(SESSIONS_ROOT, dir))
    .map((entry) => path.join(SESSIONS_ROOT, dir, entry, "session.v4.jsonl.zstd")))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    const calls = new Map();
    for (const e of readEvents(file)) {
      if (e.type === "tool/call") calls.set(e.data.callId, e.data.name);
      if (e.type !== "tool/result" || calls.get(e.data.message.toolCallId) !== tool || e.data.message.isError) continue;
      const text = e.data.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (/^- \[[^\n]*\]\(https?:\/\//m.test(text) || /^Fetched https?:\/\//.test(text)) {
        return { sid: path.basename(path.dirname(file)), seq: e.seq, content: e.data.message.content };
      }
    }
  }
  return undefined;
}

/** Lines that differ, plus the first and last two lines, for a compact before/after. */
function excerpt(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const show = new Set([0, 1, b.length - 2, b.length - 1]);
  b.forEach((line, i) => { if (line !== a[i]) show.add(i); });
  return [...show].filter((i) => i >= 0 && i < b.length).sort((x, y) => x - y)
    .map((i) => `    ${String(i + 1).padStart(3)} before: ${(a[i] ?? "(none)").slice(0, 150)}\n        after:  ${b[i].slice(0, 150)}`)
    .join("\n");
}

for (const tool of ["web_search", "advanced_search", "platform_search", "web_fetch"]) {
  test(`labels a real ${tool} result and carries the citation line once`, () => {
    const found = firstRealResult(tool);
    assert.ok(found, `no real ${tool} result with sources in the session logs`);
    const labeled = labelContent(found.content, allocator(emptyState()).labelFor);
    const before = found.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const after = labeled.filter((c) => c.type === "text").map((c) => c.text).join("");
    console.log(`\n== ${tool}: ${found.sid} seq ${found.seq}\n${excerpt(before, after)}`);
    assert.equal(after.split(CITE_LINE_TO).length - 1, 1);
    assert.ok(!after.includes(CITE_LINE_FROM));
    assert.match(after, /\[S1\] /);
  });
}
