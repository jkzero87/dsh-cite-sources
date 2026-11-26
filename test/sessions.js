/** Real desktop session logs and the offline oracle, for tests. Read-only. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allocator, createFold, emptyState, labelContent } from "../lib/labels.js";

export const SESSIONS_ROOT = path.join(os.homedir(), ".local/share/deepseek-harness/sessions");
export const LABELED_TOOLS = new Set(["web_search", "advanced_search", "platform_search", "web_fetch"]);
/** The plugin's fold for the default tool set. */
export const foldEvent = createFold(LABELED_TOOLS);
const ORACLE = path.join(import.meta.dirname, "url_audit_export.py");

/** Session file for an id or id prefix (`2516f527`). */
export function sessionPath(idPrefix) {
  for (const dir of fs.readdirSync(SESSIONS_ROOT)) {
    for (const entry of fs.readdirSync(path.join(SESSIONS_ROOT, dir))) {
      if (entry.startsWith(`session-${idPrefix}`)) {
        const file = path.join(SESSIONS_ROOT, dir, entry, "session.v4.jsonl.zstd");
        if (fs.existsSync(file)) return file;
      }
    }
  }
  throw new Error(`no session ${idPrefix}`);
}

/** All parseable events of a session (a live session may end in a partial line). */
export function readEvents(file) {
  const raw = execFileSync("zstd", ["-dqc", "--", file], { maxBuffer: 1 << 30 }).toString("utf8");
  return raw.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // partial trailing line of a live session
    }
  });
}

/** Last assistant text of each turn (compare.py's "final answer"). */
export function finalAnswers(events) {
  const answers = new Map();
  for (const e of events) {
    if (e.type !== "assistant/message") continue;
    const text = (e.data.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
    if (text.trim()) answers.set(e.data.turn, text);
  }
  return answers;
}

/**
 * Replay the plugin over a real log: each successful root result of a labeled tool is rewritten as
 * `tools/post-execute` would before it is committed, then folded into the projection state.
 * @returns {{ state: object, labeledResults: number }}
 */
export function replayLabels(events) {
  let state = emptyState();
  const calls = new Map();
  let labeledResults = 0;
  for (const e of events) {
    if (e.type === "tool/call") calls.set(e.data.callId, e.data.name);
    let event = e;
    if (e.type === "tool/result" && LABELED_TOOLS.has(calls.get(e.data.message.toolCallId)) && !e.data.message.isError) {
      const alloc = allocator(state);
      const content = labelContent(e.data.message.content, alloc.labelFor);
      event = { ...e, data: { ...e.data, message: { ...e.data.message, content } } };
      labeledResults++;
    }
    state = foldEvent(state, event);
  }
  return { state, labeledResults };
}

/** url_audit.py classes for the fixed window 2026-10-13 to the 2026-10-26 15:41:15 measurement. */
export function oracleClasses() {
  return JSON.parse(execFileSync("python3", ["-I", ORACLE, "classes"], { maxBuffer: 1 << 26 }).toString("utf8"));
}

/** compare.py normalize_url over a list of URLs. */
export function oracleNormalize(urls) {
  return JSON.parse(execFileSync("python3", ["-I", ORACLE, "normalize"], { input: JSON.stringify(urls), maxBuffer: 1 << 26 }).toString("utf8"));
}

/** Decoded spellings (compare.py rules, Python) of the seen URLs each cited `{sid, raw}` normalizes to. */
export function oracleCanonical(requests) {
  return JSON.parse(execFileSync("python3", ["-I", ORACLE, "canonical"], { input: JSON.stringify(requests), maxBuffer: 1 << 26 }).toString("utf8"));
}

/** url_audit.py classes for an arbitrary answer text (e.g. the plugin-rewritten one) of a session. */
export function oracleAnswerClasses(sidPrefix, answer, file = null) {
  return JSON.parse(execFileSync("python3", ["-I", ORACLE, "answer-classes"], { input: JSON.stringify({ sid: sidPrefix, answer, file }), maxBuffer: 1 << 26 }).toString("utf8"));
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split text into random chunk sizes in [1, max]. */
export function randomChunks(text, seed, max = 24) {
  const rand = prng(seed);
  const chunks = [];
  for (let i = 0; i < text.length;) {
    const n = 1 + Math.floor(rand() * max);
    chunks.push(text.slice(i, i + n));
    i += n;
  }
  return chunks;
}
