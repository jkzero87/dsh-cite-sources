/**
 * Fixture: the 17:06 session (dbc5673f) — the model's final answer cites the group `(S2, S6)` plus
 * the single ids `(S1)` and `(S3)`. Per spec the transducer must:
 *   - expand each group to SHORT links `[S#](<canonical url>)` in the model's SAME delimiters, with
 *     titles appearing ONLY in the `Fuentes:` block — `(S1)` → `([S1](url1))`,
 *     `(S2, S6)` → `([S2](url2), [S6](url6))`, `(S3)` → `([S3](url3))`;
 *   - keep the answer otherwise verbatim;
 *   - append `\n\nFuentes:` and one `- [S#] <title> — <canonical url>` line per cited id, in
 *     first-citation order, at block end (so the deltas still concatenate to the end text);
 *   - stay chunking-independent for every seed in SEEDS.
 * And on the REWRITTEN text, url_audit.py must report 0 NEAR and 0 ABSENT (EXACT is expected:
 * every URL that appears is the canonical spelling of a seen URL, emitted by the plugin itself).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransducer } from "../lib/transducer.js";
import { finalAnswers, oracleAnswerClasses, randomChunks, readEvents, replayLabels, sessionPath } from "./sessions.js";

const SID = "dbc5673f";
const MARKER = " ⚠️(unverified)";
const SEEDS = [1, 2, 3, 7, 42, 1234, 99991, 2026];
const SESSION_FILE = "~/.local/share/deepseek-harness/sessions/--home-jkzero-dsh-scratch--/session-dbc5673f-b5cc-411c-8def-63297e66a00f/session.v4.jsonl.zstd";

const events = readEvents(sessionPath(SID));
const { state } = replayLabels(events);
const answer = finalAnswers(events).get(1);
assert.ok(answer.includes("(S2, S6)"), "fixture: the 17:06 answer must cite the group (S2, S6)");

// Ground truth: the labels the model saw in the turn-1 web_search result (seq 20) of dbc5673f.
const u1 = "https://es.wikipedia.org/wiki/Abelardo_de_la_Espriella";
const u2 = "https://caracol.com.co/2026/06/21/abelardo-de-la-espriella-es-el-presidente-electo-de-colombia/";
const u3 = "https://en.wikipedia.org/wiki/Abelardo_de_la_Espriella";
const u6 = "https://www.colombia.com/actualidad/politica/abelardo-de-la-espriella-es-elegido-nuevo-presidente-de-colombia-588764";
const t1 = "Abelardo de la Espriella - Wikipedia, la enciclopedia libre";
const t2 = "Abelardo de la Espriella es el nuevo presidente de Colombia 2026-2030";
const t3 = "Abelardo de la Espriella - Wikipedia";
const t6 = "Abelardo de la Espriella es elegido nuevo presidente de Colombia";

test("the replayed map is the one logged in the turn-1 web_search result", () => {
  assert.deepEqual(state.sources[1], { url: u1, title: t1 });
  assert.deepEqual(state.sources[2], { url: u2, title: t2 });
  assert.deepEqual(state.sources[3], { url: u3, title: t3 });
  assert.deepEqual(state.sources[6], { url: u6, title: t6 });
});

const opts = { sources: state.sources, seen: state.seen, marker: MARKER };

function runChunked(chunks) {
  const t = createTransducer(opts);
  let out = "";
  for (const c of chunks) out += t.push(c);
  return out + t.flush();
}
const rewritten = runChunked([answer]);

console.log("== 17:06 fixture (dbc5673f) ==");
console.log("--- original ---");
console.log(answer);
console.log("--- rewritten ---");
console.log(rewritten);

const expectedBody =
  `El presidente de Colombia es **Abelardo de la Espriella**, abogado, político y empresario, ` +
  `presidente de la República desde el 7 de agosto de 2026 ([S1](${u1})). ` +
  `Fue elegido tras vencer a Iván Cepeda en la segunda vuelta de las elecciones presidenciales de 2026, ` +
  `para el periodo 2026-2030 ([S2](${u2}), [S6](${u6})). ` +
  `Es el fundador y líder del partido de ultraderecha Defensores de la Patria ([S3](${u3})).`;

const expectedBlock = [
  `[S1] ${t1} — ${u1}`,
  `[S2] ${t2} — ${u2}`,
  `[S6] ${t6} — ${u6}`,
  `[S3] ${t3} — ${u3}`,
].map((l) => `- ${l}`).join("\n");

test("groups are expanded to SHORT links in the model's same delimiters", () => {
  assert.ok(rewritten.includes(`([S1](${u1}))`), "(S1) → ([S1](url1))");
  assert.ok(rewritten.includes(`([S2](${u2}), [S6](${u6}))`), "(S2, S6) → ([S2](url2), [S6](url6))");
  assert.ok(rewritten.includes(`([S3](${u3}))`), "(S3) → ([S3](url3))");
  assert.ok(!rewritten.includes("(S1)") && !rewritten.includes("(S2, S6)") && !rewritten.includes("(S3)"), "no raw ids left");
});

test("the answer body is otherwise verbatim (nothing else substituted or altered)", () => {
  const idx = rewritten.indexOf("\n\nFuentes:");
  assert.ok(idx !== -1, "a Fuentes block was appended");
  assert.equal(rewritten.slice(0, idx), expectedBody);
});

test("the Fuentes block lists the cited ids in first-citation order with title and canonical URL", () => {
  const idx = rewritten.indexOf("\n\nFuentes:\n");
  assert.ok(idx !== -1, "a Fuentes block was appended");
  const actual = rewritten.slice(idx + "\n\nFuentes:".length).replace(/^\n/, "");
  assert.equal(actual, expectedBlock);
});

test("chunking-independent: every seed in SEEDS reproduces the same rewritten text", () => {
  for (const seed of SEEDS) {
    assert.equal(runChunked(randomChunks(answer, seed)), rewritten, `seed ${seed}`);
  }
  let one = "";
  const t = createTransducer(opts);
  for (const c of answer.split("")) one += t.push(c);
  assert.equal(one + t.flush(), rewritten, "1-char chunking");
});

test("url_audit on the REWRITTEN text: 0 NEAR, 0 ABSENT (every URL is a canonical seen spelling)", () => {
  const rows = oracleAnswerClasses(SID, rewritten, SESSION_FILE);
  console.log("rewritten answer URLs:", rows.map((r) => `${r.cls} ${r.raw}`));
  const near = rows.filter((r) => r.cls === "NEAR");
  const absent = rows.filter((r) => r.cls === "ABSENT");
  assert.equal(near.length, 0, `NEAR URLs must be 0, got ${near.length}`);
  assert.equal(absent.length, 0, `ABSENT URLs must be 0, got ${absent.length}`);
});
