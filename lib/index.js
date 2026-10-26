/**
 * dsh-cite-sources: citable source labels for web tools and a verified-citation rewrite of assistant text.
 *
 * - `tools/post-execute`: labels each source of the configured web tools as `[S#]` in the tool result
 *   content (logged as `tool/result`; `meta`, and so the UI cards, is unchanged). Labels continue across
 *   the session; an exact URL already labeled keeps its label.
 * - Host-only projection `citeSources`: the label map and the URLs seen in tool results, folded from logged
 *   `tool/result` events, so it is rebuilt from the log on resume.
 * - `llm/stream`: rewrites text blocks of agent-loop requests while they stream (see transducer.js). The
 *   rewritten deltas and block end are what the loop logs as `assistant/message`.
 *
 * Agent-loop requests are recognized through the agent-scoped `agent/request` hook (the mechanism dsh-recall
 * relies on: it acts only on agent hooks): the loop sends its request with the same turn `signal` object that
 * hook receives, and without `purpose` (title and compaction calls set one). A step whose assistant stream ends
 * without a matched request is reported as a warning, so the rewrite cannot stop silently.
 *
 * Trace: `ctx.logger` and one line per event appended to `traceFile` (default `logs/cite-sources.log` under
 * the DeepSeek Harness home); the desktop host mounts no logger output, so the file is the persistent record.
 */
import fs from "node:fs";
import path from "node:path";
import { allocator, emptyState, foldEvent, labelContent, stateSchema } from "./labels.js";
import { rewriteStream } from "./stream.js";

const name = "cite-sources";
const inject = ["sessions", "sessionProjections"];

const PROJECTION_KEY = "citeSources";
const DEFAULT_TOOLS = ["web_search", "advanced_search", "platform_search", "web_fetch"];
const DEFAULT_MARKER = " ⚠️(unverified)";
const DEFAULT_TRACE_FILE = "logs/cite-sources.log";
const VERDICTS = ["substituted", "unknown", "exact", "canonicalized", "prefix", "marked"];

/** Validate the row config; misconfiguration fails at load. */
function resolveConfig(config) {
  const tools = config?.tools ?? DEFAULT_TOOLS;
  const marker = config?.marker ?? DEFAULT_MARKER;
  const traceFile = config?.traceFile ?? DEFAULT_TRACE_FILE;
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === "string" && t.length > 0)) {
    throw new TypeError("cite-sources: config.tools must be a non-empty array of tool names");
  }
  if (typeof marker !== "string" || marker.length === 0) {
    throw new TypeError("cite-sources: config.marker must be a non-empty string");
  }
  if (typeof traceFile !== "string" || traceFile.length === 0) {
    throw new TypeError("cite-sources: config.traceFile must be a non-empty path");
  }
  return { tools: new Set(tools), marker, traceFile };
}

/** Logger plus append-only trace file; a failing file write is reported once through the logger. */
function createTrace(ctx, traceFile) {
  let file = traceFile;
  if (!path.isAbsolute(file)) {
    if (typeof ctx.dshHomePath !== "function") {
      throw new TypeError("cite-sources: config.traceFile is relative but the host provides no dshHomePath");
    }
    file = ctx.dshHomePath(file);
  }
  let writeFailed = false;
  return {
    file,
    write(level, message) {
      ctx.logger[level](message);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
      } catch (error) {
        if (!writeFailed) ctx.logger.warn(`[cite-sources] cannot write trace file ${file}: ${error.message}`);
        writeFailed = true;
      }
    },
  };
}

function apply(ctx, config) {
  const { tools, marker, traceFile } = resolveConfig(config);
  const trace = createTrace(ctx, traceFile);
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema,
    stateVersion: 2,
    init: () => emptyState(),
    apply: foldEvent,
  });
  const readState = (session) => ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? emptyState();
  // Labels handed out to results not yet committed (parallel calls in one step), per session.
  const reserved = new WeakMap();
  // Session id -> the step the loop is about to request: { signal, turn, step, matched, warned }.
  const armed = new Map();
  // Session id -> { announced, turn, rewrote, counts } for the trace.
  const stats = new Map();
  const statsOf = (sessionId) => {
    if (!stats.has(sessionId)) stats.set(sessionId, { announced: false, turn: 0, rewrote: false, counts: {} });
    return stats.get(sessionId);
  };

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    const session = exec.agent?.session;
    if (decision.kind !== "accept" || Object.hasOwn(decision, "value") || result.isError
      || exec.parent !== undefined || session === undefined || !tools.has(exec.name)) {
      return decision;
    }
    const alloc = allocator(readState(session), reserved.get(session) ?? 0);
    const content = labelContent(decision.content ?? result.content, alloc.labelFor);
    reserved.set(session, alloc.next());
    return { ...decision, content };
  });

  ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
    const config = await next();
    armed.set(agent.session.id, { signal, turn, step, matched: false, warned: false });
    return config;
  });

  ctx.on("llm/stream", (options, next) => {
    const step = options.sessionId === undefined ? undefined : armed.get(options.sessionId);
    if (step === undefined || options.signal !== step.signal || options.purpose !== undefined) return next();
    const session = ctx.sessions.get(options.sessionId);
    if (session === undefined) return next();
    step.matched = true;
    const s = statsOf(options.sessionId);
    if (s.turn !== step.turn) s.counts = {};
    s.turn = step.turn;
    s.rewrote = true;
    const readAndAnnounce = () => {
      const state = readState(session);
      if (!s.announced) {
        trace.write("info", `[cite-sources] active session=${options.sessionId} sources=${Object.keys(state.sources).length}`);
        s.announced = true;
      }
      return state;
    };
    const count = (d) => { s.counts[d.verdict] = (s.counts[d.verdict] ?? 0) + 1; };
    return rewriteStream(next(), readAndAnnounce, marker, count);
  });

  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (frame.type !== "end") return;
    const step = armed.get(agent.session.id);
    if (step === undefined || step.matched || step.warned) return;
    step.warned = true;
    trace.write("warn", `[cite-sources] NOT ACTIVE session=${agent.session.id} turn=${step.turn} step=${step.step}: the agent-loop request did not reach the llm/stream rewrite`);
  });

  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    const s = stats.get(agent.session.id);
    if (s === undefined || s.turn !== turn || !s.rewrote) return;
    const parts = VERDICTS.map((v) => `${v}=${s.counts[v] ?? 0}`).join(" ");
    trace.write("info", `[cite-sources] turn session=${agent.session.id} turn=${turn} ${parts}`);
    s.counts = {};
    s.rewrote = false;
  });

  trace.write("info", `[cite-sources] loaded tools=${[...tools].join(",")} trace=${trace.file}`);
}

export { name, inject, apply };
