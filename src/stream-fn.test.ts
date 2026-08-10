/**
 * Tests for the browser StreamFn, run with `node --test` against a fake fetch.
 *
 * Two things are worth testing here and the rest is not: the **SSE framing**,
 * because a chunk boundary can fall mid-frame and getting that wrong drops the
 * tail of a response often enough to look like a model quirk; and the **error
 * contract**, because `StreamFn` must never throw or reject and a violation
 * surfaces inside the agent loop as an unhandled failure rather than as a turn
 * the agent can report.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createBrowserStreamFn } from "./stream-fn";

const MODEL = {} as never;
const ctx = (text = "hi") =>
  ({ messages: [{ role: "user", content: [{ type: "text", text }] }] }) as never;

/** A Response whose body arrives in exactly the chunks given. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

async function collect(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of stream) seen.push(event.type);
  return seen;
}

test("streams text and finishes with done", async () => {
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
  });
  const stream = await streamFn(MODEL, ctx());
  const types = await collect(stream as never);
  const message = await (stream as never as { result(): Promise<any> }).result();

  assert.deepEqual(types, ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
  assert.equal(message.content[0].text, "Hello");
  assert.equal(message.stopReason, "stop");
});

test("reassembles a frame split across chunk boundaries", async () => {
  // The failure this guards: a naive per-chunk parse loses "lo" here, and the
  // symptom is a response that is subtly truncated rather than obviously
  // broken.
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel',
        '"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
  });
  const stream = await streamFn(MODEL, ctx());
  await collect(stream as never);
  const message = await (stream as never as { result(): Promise<any> }).result();
  assert.equal(message.content[0].text, "Hello");
});

test("accumulates a tool call across deltas", async () => {
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/a\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
  });
  const stream = await streamFn(MODEL, ctx());
  await collect(stream as never);
  const message = await (stream as never as { result(): Promise<any> }).result();
  const call = message.content.find((c: any) => c.type === "toolCall");
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "/a" });
  assert.equal(message.stopReason, "toolUse");
});

test("surfaces unparseable tool arguments instead of calling with {}", async () => {
  // The model's error, not the transport's. Silently substituting `{}` would
  // call the tool with nothing and blame the tool.
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{not json"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
  });
  const stream = await streamFn(MODEL, ctx());
  await collect(stream as never);
  const message = await (stream as never as { result(): Promise<any> }).result();
  const call = message.content.find((c: any) => c.type === "toolCall");
  assert.equal(call.arguments.__unparsed, "{not json");
});

test("encodes an HTTP failure into the stream rather than throwing", async () => {
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async () => new Response("upstream is unhappy", { status: 502, statusText: "Bad Gateway" }),
  });
  const stream = await streamFn(MODEL, ctx());
  const types = await collect(stream as never);
  const message = await (stream as never as { result(): Promise<any> }).result();

  assert.deepEqual(types, ["error"]);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage, /502/);
  assert.match(message.errorMessage, /upstream is unhappy/);
});

test("encodes a transport failure rather than rejecting", async () => {
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  // The contract in one assertion: awaiting this must not reject.
  const stream = await streamFn(MODEL, ctx());
  const types = await collect(stream as never);
  const message = await (stream as never as { result(): Promise<any> }).result();
  assert.deepEqual(types, ["error"]);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage, /network down/);
});

test("reports an abort as aborted, not as an error", async () => {
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    },
  });
  const stream = await streamFn(MODEL, ctx());
  await collect(stream as never);
  const message = await (stream as never as { result(): Promise<any> }).result();
  assert.equal(message.stopReason, "aborted");
});

test("sends exactly two headers, so no CORS preflight is triggered", async () => {
  // The whole reason this exists rather than reusing pi-ai's streamSimple.
  // A third custom header turns every request into two and makes the
  // endpoint's CORS configuration part of our contract.
  let seen: Record<string, string> = {};
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: async (_url, init) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return sseResponse(["data: [DONE]\n\n"]);
    },
  });
  await collect((await streamFn(MODEL, ctx())) as never);

  assert.deepEqual(Object.keys(seen).sort(), ["authorization", "content-type"]);
  assert.ok(!Object.keys(seen).some((h) => h.toLowerCase().startsWith("x-")));
});

test("omits authorization entirely when there is no key", async () => {
  // The keyless platform proxy: a compartment runs with zero credentials of
  // its own, so an empty bearer must not be invented.
  let seen: Record<string, string> = {};
  const streamFn = createBrowserStreamFn({
    baseUrl: "https://proxy.test/v1",
    model: "m",
    fetchImpl: async (_url, init) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return sseResponse(["data: [DONE]\n\n"]);
    },
  });
  await collect((await streamFn(MODEL, ctx())) as never);
  assert.deepEqual(Object.keys(seen), ["content-type"]);
});
