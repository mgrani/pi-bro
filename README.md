# pi-bro

Run [Pi](https://github.com/earendil-works/pi)'s agent core **in a browser**.

Pi's `pi-agent-core` is already built for this — the model layer is injectable
(`StreamFn`), Node-specific code sits behind a `./node` export, and the
execution surface is an interface. What a page still needs is an
`ExecutionEnv`. That is what this provides.

## Status

Early. The `ExecutionEnv` is implemented and typechecks against Pi 0.83's
declarations; the shell allowlist and helpers are not written yet.

**Measured, not assumed** (Pi 0.83, esbuild `--platform=browser`):

- `pi-agent-core` bundles for the browser with **zero** errors — no Node
  builtin ever needs resolving.
- **≈ 108 kb gzipped** for the core alone; **≈ 450 kb** once
  `@earendil-works/pi-ai/compat` is pulled in for a ready-made `StreamFn`.
- A Pi agent **completes a real turn in headless Chromium**.

## Usage

```ts
import { createBrowserExecutionEnv } from "pi-bro";
import LightningFS from "@isomorphic-git/lightning-fs";

const fs = new LightningFS("workspace").promises;
const env = createBrowserExecutionEnv({ fs, cwd: "/repo" });
```

Pass `env` where Pi's harness expects an `ExecutionEnv`, and register only the
tools that suit a page — `createReadTool`, `createWriteTool`, `createEditTool`
work unchanged; **do not register `createBashTool`**.

## Design

**One filesystem.** Everything binds a single volume. `lightning-fs` supports
several named stores, so a git checkout in one and a scratch area in another is
a two-line mistake that produces an agent whose `grep` and whose `read`
disagree about what exists. Temp paths live inside the tree (`<cwd>/.tmp`).

**No shell, said out loud.** `exec` returns Pi's own `shell_unavailable`
error, and the message names what to use instead. A refusal that teaches beats
one that merely fails — and a model offered a `bash` tool will reach for
`npm test` and collect errors, so the tool is better left unregistered than
half-implemented.

**Honest errors.** `exists()` returns `false` only for `not_found` and
propagates everything else: a permission failure must not read as "absent".
`canonicalPath` does not fake symlink resolution, because a wrong answer is
worse than an honest syntactic one.

## Two things to know before using it in anger

- **CORS.** Calling a model endpoint directly from a page is subject to that
  provider's CORS policy. The `openai` SDK sends `x-stainless-*` headers, which
  strict allowlists reject — a **same-origin proxy** avoids the problem
  entirely and keeps the credential off the client.
- **Bundle.** Importing `pi-ai/compat` for `streamSimple` costs ~4× the core.
  A hand-written `StreamFn` over plain `fetch` is smaller and sidesteps the
  CORS issue above.

## Licence

MIT. Pi is MIT (`earendil-works/pi`); this implements its published interfaces
and vendors none of its code.
