/**
 * Fold invariant over every desktop session with labels: after each logged result of a labeled tool, the
 * fold maps every `[S#] <title> — <url>` (or `Fetched [S#] <url>`) line of that result to exactly that url
 * and title; at the end of the session the map still holds those sources and no other ids; an id is never logged for two sources.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { emptyState } from "../lib/labels.js";
import { foldEvent, LABELED_TOOLS, readEvents, SESSIONS_ROOT } from "./sessions.js";

const LABELED_SOURCE = /^- \[S(\d+)\] (.*?) — (https?:\/\/(?:[^()\s]|\([^()\s]*\))+)/;
const LABELED_FETCH = /^Fetched \[S(\d+)\] (https?:\/\/\S+) \(HTTP \d+\)/;

function loggedLabels(event) {
  const text = (event.data.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return text.split("\n").flatMap((line) => {
    const s = LABELED_SOURCE.exec(line);
    if (s) return [{ id: Number(s[1]), url: s[3], title: s[2] }];
    const f = LABELED_FETCH.exec(line);
    return f ? [{ id: Number(f[1]), url: f[2], title: "" }] : [];
  });
}

function sessionFiles() {
  return fs.readdirSync(SESSIONS_ROOT).flatMap((dir) => fs.readdirSync(path.join(SESSIONS_ROOT, dir))
    .filter((entry) => entry.startsWith("session-"))
    .map((entry) => path.join(SESSIONS_ROOT, dir, entry, "session.v4.jsonl.zstd"))
    .filter((file) => fs.existsSync(file)));
}

test("fold invariant: each labeled result's logged lines are exactly the fold map; ids never reused", () => {
  const violations = [];
  let checkedSessions = 0;
  let checkedResults = 0;
  for (const file of sessionFiles()) {
    const sid = path.basename(path.dirname(file)).slice("session-".length, "session-".length + 8);
    const events = readEvents(file);
    const calls = new Map();
    const logged = new Map(); // id -> { url, title } as first logged by a labeled tool
    let state = emptyState();
    let labeledResults = 0;
    for (const e of events) {
      if (e.type === "tool/call") calls.set(e.data.callId, e.data.name);
      state = foldEvent(state, e);
      if (e.type !== "tool/result" || e.data.message.isError || !LABELED_TOOLS.has(calls.get(e.data.message.toolCallId))) continue;
      const labels = loggedLabels(e);
      if (labels.length === 0) continue;
      labeledResults++;
      for (const { id, url, title } of labels) {
        const got = state.sources[id];
        if (got?.url !== url || got?.title !== title) {
          violations.push(`${sid} seq=${e.seq} S${id}: logged ${url} | ${title} ; fold ${got?.url} | ${got?.title}`);
        }
        if (!logged.has(id)) logged.set(id, { url, title });
        else if (logged.get(id).url !== url) violations.push(`${sid} seq=${e.seq} S${id} reused: ${logged.get(id).url} then ${url}`);
      }
    }
    if (labeledResults === 0) continue;
    checkedSessions++;
    checkedResults += labeledResults;
    for (const [id, { url, title }] of logged) {
      const got = state.sources[id];
      if (got?.url !== url || got?.title !== title) violations.push(`${sid} end S${id}: logged ${url} | ${title} ; fold ${got?.url} | ${got?.title}`);
    }
    for (const id of Object.keys(state.sources)) {
      if (!logged.has(Number(id))) violations.push(`${sid} S${id} in fold map but in no labeled result: ${state.sources[id].url}`);
    }
  }
  console.log(`fold invariant: ${checkedSessions} sessions, ${checkedResults} labeled results, ${violations.length} violations`);
  for (const v of violations.slice(0, 30)) console.log(`  VIOLATION ${v}`);
  assert.ok(checkedSessions > 0, "no desktop session with labeled results");
  assert.deepEqual(violations, []);
});
