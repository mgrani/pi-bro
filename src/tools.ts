/**
 * M1 — the tool registry: what a browser compartment can actually do.
 *
 * The registry exists to make that set **stated rather than accidental**. A
 * host that assembles tools inline ends up with a capability surface nobody
 * can read off one place, and "can this agent write files?" becomes a question
 * you answer by grepping. Here it is one call with one options object, and the
 * defaults are the conservative ones.
 *
 * Three rules it enforces, each of which is a decision from the plan rather
 * than a preference:
 *
 * 1. **A tool the host did not enable is not registered at all.** It is not
 *    registered-and-refusing. A model offered a capability that always fails
 *    spends turns discovering that; a model never offered it simply works
 *    within what exists. (`ExecutionEnv.exec` still refuses as a *value* for
 *    anything that reaches it by another path — belt and braces, different
 *    layer.)
 * 2. **Read-only by default.** `write` and `edit` are opt-in, because the
 *    compartment's filesystem is a **git working copy** and an agent that can
 *    silently rewrite it before anyone has looked is a different risk from an
 *    agent that can read it.
 * 3. **The shell is opt-in and read-only even then** (see `./shell`), and its
 *    allowlist is put in the tool description rather than left to be
 *    discovered by trial — a boundary works by being stated.
 */
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionEnv,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { allowlistSummary } from "./shell";

export interface BrowserToolsOptions {
  /** The one filesystem: the git working copy. See `./execution-env`. */
  env: ExecutionEnv;
  /**
   * Allow `write` and `edit`. Off by default: the compartment's filesystem is
   * a git working copy, and an agent that can rewrite it unobserved is a
   * different proposition from one that can read it.
   */
  write?: boolean;
  /**
   * Register the `bash` tool, backed by the read-only allowlist. Off by
   * default, and only meaningful when the `ExecutionEnv` was itself built with
   * `shell: true` — otherwise every call refuses as a value, which is the
   * "registered but always fails" state rule 1 exists to avoid.
   */
  shell?: boolean;
  /**
   * Anything the host supplies itself — the `yoars` tool at M2, git at M4.
   * Appended last so a host tool can never be silently shadowed by a built-in
   * of the same name: duplicates are rejected below rather than resolved.
   */
  extra?: AgentHarnessTool<ExecutionToolContext>[];
}

/** The registry's own view of what it built, for a host that wants to show it. */
export interface BrowserToolset {
  tools: AgentHarnessTool<ExecutionToolContext>[];
  /** Tool names, in registration order. */
  names: string[];
  context: ExecutionToolContext;
}

export function createBrowserToolset(options: BrowserToolsOptions): BrowserToolset {
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [
    createReadTool() as AgentHarnessTool<ExecutionToolContext>,
  ];

  if (options.write) {
    tools.push(createWriteTool() as AgentHarnessTool<ExecutionToolContext>);
    tools.push(createEditTool() as AgentHarnessTool<ExecutionToolContext>);
  }

  if (options.shell) {
    const bash = createBashTool() as AgentHarnessTool<ExecutionToolContext>;
    // State the boundary in the description the model actually reads. The
    // alternative is an agent that learns the allowlist by hitting it, which
    // costs turns and reads to a human like the agent is malfunctioning.
    tools.push({
      ...bash,
      description: `${bash.description}\n\n${allowlistSummary}`,
    });
  }

  for (const tool of options.extra ?? []) {
    if (tools.some((existing) => existing.name === tool.name)) {
      // Refuse rather than resolve. Two tools with one name is a host bug,
      // and picking a winner here would make which one runs depend on
      // registration order -- a difference nobody would think to look for.
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    tools.push(tool);
  }

  return {
    tools,
    names: tools.map((tool) => tool.name),
    context: { env: options.env },
  };
}
