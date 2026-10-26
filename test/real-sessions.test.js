/**
 * Tests 2 and 3 against real sessions and url_audit.py's classes, plus normalize parity with compare.py.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalUrl, normalizeUrl, urlsIn } from "../lib/normalize.js";
import { isVerifiedUrl, rewriteText } from "../lib/transducer.js";
import { finalAnswers, LABELED_TOOLS, oracleCanonical, oracleClasses, oracleNormalize, readEvents, replayLabels, sessionPath } from "./sessions.js";

const MARKER = " ⚠️(unverified)";
const DETAIL_SESSIONS = ["2516f527", "caf6378d", "f0d2a1d6", "ed68c8f7", "1dd30925", "0388bf95", "1ebdc841"];
// Sessions whose NEAR citations normalize to a seen URL (decoded redirects, `&&`): the emitted URL must be canonical.
const CANONICAL_SESSIONS = new Set(["ed68c8f7", "0388bf95", "1ebdc841"]);
const rows = oracleClasses();
const replays = new Map();
const replayOf = (sid) => {
  if (!replays.has(sid)) {
    const events = readEvents(sessionPath(sid.replace(/^session-/, "")));
    replays.set(sid, { events, ...replayLabels(events) });
  }
  return replays.get(sid);
};

/** The transducer's URL rule alone: trailing backtick ends the URL; `.,;:*` is not part of it. */
const coreOf = (raw) => raw.replace(/`+$/, "").replace(/[.,;:*]+$/, "");
const isMarked = (raw, seenKeys) => !isVerifiedUrl(coreOf(raw), seenKeys);

function levenshteinRatio(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length, 1);
}

test("url_audit oracle has the 125 URLs measured on 2026-10-26", () => {
  const counts = rows.reduce((c, r) => ({ ...c, [r.cls]: (c[r.cls] ?? 0) + 1 }), {});
  console.log(`oracle rows: ${rows.length}`, counts);
  assert.equal(rows.length, 125);
});

test("normalizeUrl matches compare.py normalize_url on every real URL in the detail sessions", () => {
  const urls = new Set(rows.map((r) => r.raw));
  for (const sid of DETAIL_SESSIONS) {
    const { events } = replayOf(rows.find((r) => r.sid.includes(sid))?.sid ?? `session-${sid}`);
    for (const e of events) {
      if (e.type !== "tool/result") continue;
      for (const c of e.data.message.content ?? []) if (c.type === "text") for (const u of urlsIn(c.text)) urls.add(u);
      for (const s of e.data.meta?.sources ?? []) if (typeof s?.url === "string") urls.add(s.url);
    }
  }
  const list = [...urls];
  const expected = oracleNormalize(list);
  const mismatches = list.flatMap((u, i) => (normalizeUrl(u) === expected[i] ? [] : [{ url: u, js: normalizeUrl(u), py: expected[i] }]));
  console.log(`normalize parity: ${list.length} URLs, ${mismatches.length} mismatches`);
  for (const m of mismatches) console.log("  MISMATCH", JSON.stringify(m));
  assert.equal(mismatches.length, 0);
});

for (const sid of DETAIL_SESSIONS) {
  test(`test 2: cited URLs of ${sid} — original, plugin output, url_audit class`, () => {
    const fullSid = rows.find((r) => r.sid.startsWith(`session-${sid}`))?.sid ?? `session-${sid}`;
    const { events, state, labeledResults } = replayOf(fullSid);
    const seenKeys = new Set(Object.keys(state.seen));
    const answers = finalAnswers(events);
    const mine = rows.filter((r) => r.sid === fullSid);
    const candidates = oracleCanonical(mine.map((r) => ({ sid: r.sid, raw: coreOf(r.raw) })));
    console.log(`\n== ${sid}: ${labeledResults} labeled tool results, ${Object.keys(state.sources).length} labels, ${seenKeys.size} seen URLs, ${mine.length} cited URLs`);
    const failures = [];
    mine.forEach((row, i) => {
      const decisions = [];
      rewriteText(answers.get(row.turn), { sources: state.sources, seen: state.seen, marker: MARKER, onDecision: (d) => decisions.push(d) });
      const core = coreOf(row.raw);
      const d = decisions.find((x) => x.kind === "url" && x.input === core);
      const oracle = candidates[i];
      const fail = (why) => failures.push({ sid, turn: row.turn, cls: row.cls, raw: row.raw, verdict: d?.verdict, output: d?.output, why });
      let counterfactual = "";
      if (d === undefined) fail("transducer did not see this URL");
      else {
        if (d.verdict === "exact" || d.verdict === "canonicalized") {
          if (!oracle.includes(d.output)) fail(`emitted ${d.output} not in oracle ${JSON.stringify(oracle)}`);
        }
        if (row.cls === "EXACT" && d.verdict === "marked") fail("EXACT marked");
        if (row.cls === "ABSENT" && d.verdict !== "marked") fail("ABSENT not marked");
        if (row.cls === "NEAR") {
          const [id, src] = Object.entries(state.sources)
            .map(([k, s]) => [k, s, levenshteinRatio(canonicalUrl(s.url), core)])
            .sort((a, b) => b[2] - a[2])[0] ?? [];
          const cf = id === undefined ? "(no labeled source)" : rewriteText(`[S${id}]`, { sources: state.sources, seen: state.seen, marker: MARKER });
          counterfactual = `\n         as [S${id}] -> ${cf}`;
          const cfExact = src !== undefined && cf === `[${src.title || src.url}](${canonicalUrl(src.url)})`;
          const canonicalOut = (d.verdict === "canonicalized" || d.verdict === "exact") && oracle.includes(d.output);
          if (d.verdict !== "marked" && !canonicalOut && !cfExact) fail("NEAR neither marked, canonical, nor exact as [S#]");
          if (CANONICAL_SESSIONS.has(sid) && oracle.length > 0 && !canonicalOut) fail("NEAR with a seen equivalent was not emitted canonically");
          if (oracle.length === 0 && d.verdict !== "marked" && d.verdict !== "prefix") fail("NEAR without a seen equivalent was not marked");
        }
      }
      console.log(`  ${row.cls.padEnd(6)} turn ${row.turn} ${String(d?.verdict).padEnd(13)} cited:   ${row.raw}`);
      console.log(`         plugin: ${d?.output}${counterfactual}`);
    });
    assert.deepEqual(failures, []);
  });
}

test("test 3: unverified check alone over all url_audit URLs (confusion matrix)", () => {
  const matrix = { EXACT: { marked: 0, unmarked: 0 }, NEAR: { marked: 0, unmarked: 0 }, ABSENT: { marked: 0, unmarked: 0 } };
  const exactMarked = [];
  const nearUnmarked = [];
  const absentUnmarked = [];
  for (const row of rows) {
    const { state } = replayOf(row.sid);
    const marked = isMarked(row.raw, new Set(Object.keys(state.seen)));
    matrix[row.cls][marked ? "marked" : "unmarked"]++;
    if (row.cls === "EXACT" && marked) exactMarked.push(row);
    if (row.cls === "NEAR" && !marked) nearUnmarked.push(row);
    if (row.cls === "ABSENT" && !marked) absentUnmarked.push(row);
  }
  console.log("\nconfusion matrix (url_audit class x plugin unverified marker):");
  console.log("  class    marked  unmarked");
  for (const [cls, m] of Object.entries(matrix)) console.log(`  ${cls.padEnd(7)} ${String(m.marked).padStart(7)} ${String(m.unmarked).padStart(9)}`);
  for (const r of exactMarked) console.log(`  EXACT marked: ${r.sid} turn ${r.turn} ${r.raw}`);
  for (const r of nearUnmarked) console.log(`  NEAR unmarked: ${r.sid} turn ${r.turn} ${r.raw}`);
  for (const r of absentUnmarked) console.log(`  ABSENT unmarked: ${r.sid} turn ${r.turn} ${r.raw}`);
  assert.equal(exactMarked.length, 0);
  assert.equal(absentUnmarked.length, 0);
});

test("tool set matches the configured default", () => {
  assert.deepEqual([...LABELED_TOOLS], ["web_search", "advanced_search", "platform_search", "web_fetch"]);
});
