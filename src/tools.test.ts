/**
 * The registry's job is to make a compartment's capability surface *stated*.
 * So what is worth testing is the shape of the set, not the tools themselves
 * (pi-agent-core owns those): what is present by default, what requires
 * opting in, and that the boundary is described rather than discovered.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createBrowserToolset } from "./tools";

const env = {} as never;

test("read-only by default", () => {
  // The compartment's filesystem is a git working copy. An agent that can
  // rewrite it unobserved is a different proposition from one that can read
  // it, so writing is a decision the host makes explicitly.
  const { names } = createBrowserToolset({ env });
  assert.deepEqual(names, ["read"]);
});

test("writing is opt-in", () => {
  const { names } = createBrowserToolset({ env, write: true });
  assert.deepEqual(names.sort(), ["edit", "read", "write"]);
});

test("a tool the host did not enable is absent, not present-and-refusing", () => {
  // A model offered a capability that always fails spends turns discovering
  // that; a model never offered it simply works within what exists.
  const { names } = createBrowserToolset({ env });
  assert.ok(!names.includes("bash"));
});

test("the shell states its allowlist in the description", () => {
  // A boundary works by being stated. The alternative is an agent learning
  // the allowlist by hitting it, which costs turns and reads to a human like
  // the agent is malfunctioning.
  const { tools } = createBrowserToolset({ env, shell: true });
  const bash = tools.find((t) => t.name === "bash");
  assert.ok(bash, "bash should be registered when the host enables it");
  assert.match(bash!.description, /grep|allowlist|ls/i);
});

test("host tools are appended and cannot be shadowed silently", () => {
  const extra = { name: "yoars", description: "d" } as never;
  const { names } = createBrowserToolset({ env, extra: [extra] });
  assert.deepEqual(names, ["read", "yoars"]);
});

test("a duplicate tool name is refused, not resolved", () => {
  // Picking a winner would make which one runs depend on registration order:
  // a difference nobody would think to look for.
  assert.throws(
    () => createBrowserToolset({ env, extra: [{ name: "read", description: "d" } as never] }),
    /duplicate tool name: read/,
  );
});

test("the context carries the one filesystem", () => {
  const marker = { marker: true } as never;
  const { context } = createBrowserToolset({ env: marker });
  assert.equal(context.env, marker);
});
