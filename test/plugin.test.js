/**
 * Plugin wiring through a minimal host context, fed with real data from session 2516f527: post-execute
 * labeling, agent-loop recognition by turn signal, title requests left alone, the NOT ACTIVE warning, and the
 * trace file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apply } from "../lib/index.js";
import { finalAnswers, randomChunks, readEvents, sessionPath } from "./sessions.js";

function fakeHost(home) {
  const handlers = new Map();
  const log = [];
  let unit;
  const ctx = {
    on: (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dshHomePath: (...segments) => path.join(home, ...segments),
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    sessionProjections: {
      register: (def) => { unit = def; },
      stateOf: () => log.reduce((state, event) => unit.apply(state, event), unit.init()),
    },
  };
  const session = { id: "session-2516f527-0242-4424-b846-94981c9efbba" };
  const call = (event, ...args) => handlers.get(event)[0](...args);
  return { ctx, session, log, call };
}

async function drain(iterable) {
  let text = "";
  for await (const chunk of iterable) if (chunk.type === "text-delta") text += chunk.text;
  return text;
}

test("plugin: labels, rewrites only the agent-loop request, and traces to the file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cite-sources-"));
  const { ctx, session, log, call } = fakeHost(home);
  apply(ctx, {});

  const events = readEvents(sessionPath("2516f527"));
  const searchResult = events.find((e) => e.type === "tool/result");
  log.push(events.find((e) => e.type === "tool/call" && e.data.callId === searchResult.data.message.toolCallId));
  const decision = await call("tools/post-execute",
    { name: "web_search", agent: { session }, parent: undefined },
    { isError: false, content: searchResult.data.message.content },
    async () => ({ kind: "accept" }));
  assert.match(decision.content[0].text, /- \[S1\] /);
  log.push({ type: "tool/result", data: { message: { ...searchResult.data.message, content: decision.content }, meta: searchResult.data.meta } });

  const turnSignal = new AbortController().signal;
  await call("agent/request", { agent: { session }, turn: 1, step: 2, signal: turnSignal }, async () => ({ provider: "p", model: "m" }));
  const answer = finalAnswers(events).get(1);
  async function* model(text) {
    for (const piece of randomChunks(text, 7)) yield { type: "text-delta", index: 0, text: piece };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
  }
  const out = await drain(call("llm/stream", { sessionId: session.id, signal: turnSignal }, () => model(answer)));
  assert.match(out, /caracol\.com\.co\/2026-06-21\/[^\s)]*\) ⚠️\(unverified\)/);

  const title = model("Quien es el presidente de Colombia https://not-seen.example/x");
  const titleOut = call("llm/stream", { sessionId: session.id, signal: new AbortController().signal, purpose: "session-title" }, () => title);
  assert.equal(titleOut, title, "a title request is passed through untouched");
  const sameSignalOtherPurpose = model("x");
  assert.equal(call("llm/stream", { sessionId: session.id, signal: turnSignal, purpose: "compaction" }, () => sameSignalOtherPurpose), sameSignalOtherPurpose);

  await call("agent/turn-stopping", { agent: { session }, turn: 1 });
  await call("agent/request", { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({}));
  call("agent/assistant-stream", { agent: { session }, frame: { type: "end", attemptId: "a", outcome: { kind: "committed" } } });

  const traced = fs.readFileSync(path.join(home, "logs/cite-sources.log"), "utf8");
  console.log(traced);
  assert.match(traced, /\[cite-sources\] loaded tools=web_search,advanced_search,platform_search,web_fetch/);
  assert.match(traced, /\[cite-sources\] active session=session-2516f527-0242-4424-b846-94981c9efbba sources=8/);
  assert.match(traced, /\[cite-sources\] turn session=\S+ turn=1 substituted=0 unknown=0 exact=2 canonicalized=0 prefix=0 marked=1/);
  assert.match(traced, /WARN \[cite-sources\] NOT ACTIVE session=\S+ turn=2 step=1/);
  fs.rmSync(home, { recursive: true });
});

test("plugin: misconfiguration fails at load", () => {
  const { ctx } = fakeHost(os.tmpdir());
  assert.throws(() => apply(ctx, { tools: [] }), /config.tools/);
  assert.throws(() => apply(ctx, { marker: "" }), /config.marker/);
  assert.throws(() => apply({ ...ctx, dshHomePath: undefined }, {}), /dshHomePath/);
});
