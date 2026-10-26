/** Model-stream wrapper that runs every text block through the citation transducer. */
import { createTransducer } from "./transducer.js";

/**
 * Wrap one model stream: text blocks pass through the transducer; every other chunk is unchanged.
 * Throws when a block end disagrees with its deltas (input) or with what was emitted (output).
 * @param {AsyncIterable<object>} upstream - the next listener's chunks.
 * @param {() => object} readState - the session's projection state when the first text block opens.
 * @param {string} marker - text appended to unverified URLs.
 */
export async function* rewriteStream(upstream, readState, marker) {
  const blocks = new Map(); // index -> { transducer, input, emitted }
  let state;
  const open = (index) => {
    let block = blocks.get(index);
    if (block === undefined) {
      state ??= readState();
      block = { transducer: createTransducer({ sources: state.sources, seen: state.seen, marker }), input: "", emitted: "" };
      blocks.set(index, block);
    }
    return block;
  };
  const flushAll = function* () {
    for (const [index, block] of blocks) {
      const rest = block.transducer.flush();
      blocks.delete(index);
      if (rest) yield { type: "text-delta", index, text: rest };
    }
  };
  for await (const chunk of upstream) {
    if (chunk.type === "text-delta") {
      const block = open(chunk.index);
      block.input += chunk.text;
      const text = block.transducer.push(chunk.text);
      block.emitted += text;
      if (text) yield { ...chunk, text };
      continue;
    }
    if (chunk.type === "block-end" && chunk.block?.type === "text") {
      const block = open(chunk.index);
      if (chunk.block.text !== block.input) {
        throw new Error(`cite-sources: text block ${chunk.index} ended with text that differs from its streamed deltas`);
      }
      const rest = block.transducer.flush();
      block.emitted += rest;
      blocks.delete(chunk.index);
      if (rest) yield { type: "text-delta", index: chunk.index, text: rest };
      const ended = { ...chunk, block: { ...chunk.block, text: block.emitted } };
      if (ended.block.text !== block.emitted) throw new Error("cite-sources: block end does not equal emitted deltas");
      yield ended;
      continue;
    }
    if (chunk.type === "finish") yield* flushAll();
    yield chunk;
  }
}
