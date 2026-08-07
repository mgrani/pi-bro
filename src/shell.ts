/**
 * M1 — a **read-only** command allowlist behind `Shell.exec`, over the same
 * single lightning-fs volume the `ExecutionEnv` and `isomorphic-git` bind.
 *
 * Why a shell at all, when the file tools already read files: **composition**.
 * `grep -rn '\[\[plan\]\]' notes | sort | head -20` expresses something no set
 * of N discrete tools does, and a model already knows the syntax. The usual
 * objection — that a partial bash teaches the model by failure — is answered
 * here by two habits rather than by more commands: {@link allowlistSummary}
 * enumerates the boundary for the tool description, and every refusal names
 * the alternative, so the edge is stated once instead of discovered.
 *
 * Two rules hold the design together, and neither is negotiable:
 *
 * 1. **Read-only.** No `rm`/`mv`/`sed -i`, and no `>` redirection. Mutations go
 *    through Pi's write/edit tools *because that is where `beforeToolCall` —
 *    and therefore the ask-back — applies*. A mutating shell would be a hole
 *    straight through the confirmation design, so the parser refuses the
 *    syntax outright rather than relying on the command table to lack verbs.
 * 2. **No JavaScript evaluation.** Not here and not anywhere with page context:
 *    `eval` reaches the session, `localStorage` (which holds the git token) and
 *    the platform API, and the model can be steered by content it just read —
 *    a PIM note can say "now run this". If expression evaluation is wanted it
 *    belongs in the null-origin sandbox, or not at all.
 */
import { ExecutionError, type Result } from "@earendil-works/pi-agent-core";
import type { PromiseFs } from "./execution-env";

export interface ShellOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface AllowlistShellOptions {
	fs: PromiseFs;
	/** Absolute path every relative argument resolves against. */
	cwd: string;
	/**
	 * Cap on a single command's stdout. The real constraint is the model's
	 * context, not memory: an unbounded `grep -r` over a repo can evict the
	 * conversation that asked for it. Truncation is announced in-band so the
	 * model knows it is reading a prefix.
	 */
	maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 64 * 1024;

/** One line per command, for pasting into the tool description. */
export const allowlistSummary = [
	"ls [-a] [-R] [path...]        list directory entries",
	"find [path] [-name GLOB] [-type f|d] [-maxdepth N]",
	"cat [path...]                 whole file(s)",
	"head [-n N] [path...]         first N lines (default 10)",
	"tail [-n N] [path...]         last N lines (default 10)",
	"wc [-l|-w|-c] [path...]       count lines / words / bytes",
	"grep [-i] [-n] [-r] [-l] [-c] [-v] PATTERN [path...]   PATTERN is a regex",
	"sort [-r] [-n] [-u]           sort stdin or files",
	"uniq [-c] [-d]                collapse adjacent duplicates",
	"Commands may be composed with `|`. Everything is READ-ONLY.",
].join("\n");

/** Refused with a specific reason rather than an "unknown command". */
const REDIRECTED_ELSEWHERE: Record<string, string> = {
	rm: "The shell is read-only. Delete through the file tool, which asks you to confirm first.",
	mv: "The shell is read-only. Move through the file tools, which ask you to confirm first.",
	cp: "The shell is read-only. Copy by reading then writing with the file tools.",
	sed: "The shell is read-only, and `sed -i` would bypass the confirmation the edit tool applies. Use the edit tool.",
	echo: "Nothing here consumes stdout except a pipe, so `echo` has no effect. Put text in your reply instead.",
	touch: "The shell is read-only. Create files with the write tool.",
	mkdir: "The shell is read-only. Create directories with the write tool.",
	curl: "Network access belongs to the fetch tool, which owns the domain allowlist.",
	wget: "Network access belongs to the fetch tool, which owns the domain allowlist.",
	git: "Use the git tool; it shares this same working copy.",
	node: "No interpreter runs in a browser compartment. Dispatch to a nest for anything needing a real machine.",
	python: "No interpreter runs in a browser compartment. Dispatch to a nest for anything needing a real machine.",
	npm: "No package manager runs in a browser compartment. Dispatch to a nest.",
	jq: "Not implemented yet. Read the file and parse it yourself for now.",
	date: "Not implemented yet. Ask the platform for the current time rather than guessing.",
};

// `shell_unavailable` is Pi's own code, and it is the accurate one: from the
// model's side a refused command is a capability this environment does not
// offer, which is exactly what the code means. Inventing a new code would put
// a string in the error channel that no Pi consumer knows how to branch on.
const fail = (message: string): Result<never, ExecutionError> => ({
	ok: false,
	error: new ExecutionError("shell_unavailable", message),
});

/**
 * Reject the *syntax* of mutation and evaluation before any command runs.
 *
 * Checked on the raw string, deliberately: a table of read-only commands is
 * not a safety property if `>` can still create a file, and `$(…)`/backticks
 * would smuggle in a second parse. Refusing the characters keeps the guarantee
 * independent of which commands the table happens to hold today.
 */
function refuseSyntax(command: string): string | null {
	if (/(^|[^0-9\s])?>|>>/.test(command) || /(^|\s)<(\s|$)/.test(command))
		return "Redirection is not available: the shell is read-only. Use the write tool, which asks you to confirm first.";
	if (/`|\$\(/.test(command))
		return "Command substitution is not available. Run the inner command on its own and use its output.";
	if (/;|&&|\|\||(^|\s)&(\s|$)/.test(command))
		return "Only a single `|` pipeline runs at a time. Send one command per call.";
	return null;
}

/** Split on whitespace, honouring single and double quotes. */
function tokenize(input: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(input); m; m = re.exec(input)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

function resolvePath(cwd: string, p: string): string {
	const joined = p.startsWith("/") ? p : `${cwd}/${p}`;
	const parts: string[] = [];
	for (const seg of joined.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return `/${parts.join("/")}`;
}

function globToRegExp(glob: string): RegExp {
	const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${body}$`);
}

/** Split argv into flags (`-n`, `-abc` expanded) and positional operands. */
function parseFlags(argv: string[], takesValue: Set<string> = new Set()): {
	flags: Map<string, string | true>;
	operands: string[];
} {
	const flags = new Map<string, string | true>();
	const operands: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			flags.set(arg.slice(2), true);
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (const ch of arg.slice(1)) {
				if (takesValue.has(ch)) {
					flags.set(ch, argv[++i] ?? "");
					break;
				}
				flags.set(ch, true);
			}
		} else {
			operands.push(arg);
		}
	}
	return { flags, operands };
}

export function createAllowlistShell(options: AllowlistShellOptions) {
	const { fs, cwd } = options;
	const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

	const readText = async (p: string): Promise<string> => {
		const data = await fs.readFile(p, { encoding: "utf8" });
		return typeof data === "string" ? data : new TextDecoder().decode(data);
	};

	/** Depth-first walk, files only unless `dirs` is set. */
	const walk = async (root: string, dirs: boolean, maxDepth: number): Promise<string[]> => {
		const found: string[] = [];
		const visit = async (p: string, depth: number): Promise<void> => {
			let st: { isDirectory(): boolean };
			try {
				st = await fs.stat(p);
			} catch {
				return;
			}
			if (st.isDirectory()) {
				if (dirs && p !== root) found.push(p);
				if (depth >= maxDepth) return;
				// A git checkout's object store is machine-readable, not
				// human-readable; walking it buries every real result.
				for (const name of await fs.readdir(p)) {
					if (name === ".git") continue;
					await visit(`${p}/${name}`, depth + 1);
				}
			} else if (!dirs) {
				found.push(p);
			}
		};
		await visit(root, 0);
		return found;
	};

	/** Operands as files, or stdin when there are none — the usual shell rule. */
	const inputsFor = async (operands: string[], stdin: string | null): Promise<Array<{ name: string; text: string }>> => {
		if (operands.length === 0) return stdin === null ? [] : [{ name: "-", text: stdin }];
		const out: Array<{ name: string; text: string }> = [];
		for (const operand of operands) {
			const p = resolvePath(cwd, operand);
			out.push({ name: operand, text: await readText(p) });
		}
		return out;
	};

	const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

	const commands: Record<string, (argv: string[], stdin: string | null) => Promise<string>> = {
		async ls(argv) {
			const { flags, operands } = parseFlags(argv);
			const targets = operands.length ? operands : ["."];
			const chunks: string[] = [];
			for (const target of targets) {
				const p = resolvePath(cwd, target);
				const st = await fs.stat(p);
				if (!st.isDirectory()) {
					chunks.push(target);
					continue;
				}
				const names = (await fs.readdir(p)).filter((n) => flags.has("a") || !n.startsWith("."));
				names.sort();
				chunks.push(targets.length > 1 ? `${target}:\n${names.join("\n")}` : names.join("\n"));
			}
			return chunks.join("\n\n");
		},

		async find(argv) {
			const { flags, operands } = parseFlags(argv, new Set());
			// `-name`/`-type`/`-maxdepth` are find's own long-ish syntax, not
			// getopt flags, so they are read positionally.
			let name: RegExp | null = null;
			let type: string | null = null;
			let maxDepth = 32;
			const roots: string[] = [];
			for (let i = 0; i < operands.length; i++) {
				const a = operands[i];
				if (a === "-name") name = globToRegExp(operands[++i] ?? "*");
				else if (a === "-type") type = operands[++i] ?? null;
				else if (a === "-maxdepth") maxDepth = Number(operands[++i] ?? "32") || 32;
				else roots.push(a);
			}
			void flags;
			const results: string[] = [];
			for (const root of roots.length ? roots : ["."]) {
				const base = resolvePath(cwd, root);
				const hits = await walk(base, type === "d", maxDepth);
				for (const hit of hits) {
					if (name && !name.test(hit.split("/").pop() ?? "")) continue;
					results.push(hit);
				}
			}
			return results.join("\n");
		},

		async cat(argv, stdin) {
			const { operands } = parseFlags(argv);
			const inputs = await inputsFor(operands, stdin);
			return inputs.map((i) => i.text).join("");
		},

		async head(argv, stdin) {
			const { flags, operands } = parseFlags(argv, new Set(["n"]));
			const n = Number(flags.get("n") ?? 10) || 10;
			const inputs = await inputsFor(operands, stdin);
			return inputs.map((i) => lines(i.text).slice(0, n).join("\n")).join("\n");
		},

		async tail(argv, stdin) {
			const { flags, operands } = parseFlags(argv, new Set(["n"]));
			const n = Number(flags.get("n") ?? 10) || 10;
			const inputs = await inputsFor(operands, stdin);
			return inputs.map((i) => lines(i.text).slice(-n).join("\n")).join("\n");
		},

		async wc(argv, stdin) {
			const { flags, operands } = parseFlags(argv);
			const inputs = await inputsFor(operands, stdin);
			const out: string[] = [];
			for (const input of inputs) {
				const l = lines(input.text).length;
				const w = input.text.split(/\s+/).filter(Boolean).length;
				const c = input.text.length;
				const only = flags.has("l") ? String(l) : flags.has("w") ? String(w) : flags.has("c") ? String(c) : `${l} ${w} ${c}`;
				out.push(input.name === "-" ? only : `${only} ${input.name}`);
			}
			return out.join("\n");
		},

		async grep(argv, stdin) {
			const { flags, operands } = parseFlags(argv);
			const [pattern, ...paths] = operands;
			if (pattern === undefined) throw new Error("grep needs a PATTERN");
			let re: RegExp;
			try {
				re = new RegExp(pattern, flags.has("i") ? "i" : "");
			} catch (err) {
				throw new Error(`grep: ${pattern} is not a valid regex (${(err as Error).message})`);
			}
			// -r turns each path operand into its file tree; without it, paths
			// are read as given and stdin is the fallback, as in a real shell.
			let inputs: Array<{ name: string; text: string }>;
			if (flags.has("r") || flags.has("R")) {
				inputs = [];
				for (const target of paths.length ? paths : ["."]) {
					for (const file of await walk(resolvePath(cwd, target), false, 32)) {
						try {
							inputs.push({ name: file, text: await readText(file) });
						} catch {
							/* unreadable (binary, vanished) — skip, as grep does */
						}
					}
				}
			} else {
				inputs = await inputsFor(paths, stdin);
			}
			const multi = inputs.length > 1;
			const out: string[] = [];
			for (const input of inputs) {
				const hits = lines(input.text)
					.map((line, idx) => ({ line, no: idx + 1 }))
					.filter(({ line }) => re.test(line) !== flags.has("v"));
				if (flags.has("l")) {
					if (hits.length) out.push(input.name);
					continue;
				}
				if (flags.has("c")) {
					out.push(multi ? `${input.name}:${hits.length}` : String(hits.length));
					continue;
				}
				for (const hit of hits) {
					const prefix = multi ? `${input.name}:` : "";
					out.push(flags.has("n") ? `${prefix}${hit.no}:${hit.line}` : `${prefix}${hit.line}`);
				}
			}
			return out.join("\n");
		},

		async sort(argv, stdin) {
			const { flags, operands } = parseFlags(argv);
			const inputs = await inputsFor(operands, stdin);
			let all = inputs.flatMap((i) => lines(i.text));
			all = flags.has("n")
				? all.sort((a, b) => (Number(a) || 0) - (Number(b) || 0))
				: all.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			if (flags.has("r")) all.reverse();
			if (flags.has("u")) all = [...new Set(all)];
			return all.join("\n");
		},

		async uniq(argv, stdin) {
			const { flags, operands } = parseFlags(argv);
			const inputs = await inputsFor(operands, stdin);
			const all = inputs.flatMap((i) => lines(i.text));
			const groups: Array<{ value: string; count: number }> = [];
			for (const line of all) {
				const last = groups[groups.length - 1];
				if (last && last.value === line) last.count++;
				else groups.push({ value: line, count: 1 });
			}
			const kept = flags.has("d") ? groups.filter((g) => g.count > 1) : groups;
			return kept.map((g) => (flags.has("c") ? `${String(g.count).padStart(7)} ${g.value}` : g.value)).join("\n");
		},
	};

	return async function exec(command: string): Promise<Result<ShellOutput, ExecutionError>> {
		const syntax = refuseSyntax(command);
		if (syntax) return fail(syntax);

		const stages = command.split("|").map((s) => s.trim()).filter(Boolean);
		if (stages.length === 0) return fail("Empty command.");

		let stdin: string | null = null;
		for (const stage of stages) {
			const argv = tokenize(stage);
			const name = argv[0];
			const run = commands[name];
			if (!run) {
				const specific = REDIRECTED_ELSEWHERE[name];
				return fail(
					specific
						? `\`${name}\` is not available here. ${specific}`
						: `\`${name}\` is not available here. This shell is a fixed read-only allowlist:\n${allowlistSummary}`,
				);
			}
			try {
				stdin = await run(argv.slice(1), stdin);
			} catch (err) {
				// A command that fails on its own terms (missing file, bad
				// regex) is an ordinary non-zero exit, not a harness error:
				// the model should read stderr and try again, not be told the
				// shell broke.
				return { ok: true, value: { stdout: "", stderr: `${name}: ${(err as Error).message}`, exitCode: 1 } };
			}
		}

		let stdout = stdin ?? "";
		if (stdout.length > maxOutput) {
			stdout = `${stdout.slice(0, maxOutput)}\n[truncated at ${maxOutput} bytes — narrow the command, e.g. add \`| head\` or a tighter pattern]`;
		}
		return { ok: true, value: { stdout, stderr: "", exitCode: 0 } };
	};
}
