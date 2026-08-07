/**
 * M1 — a browser `ExecutionEnv` for `pi-agent-core`, over **one** lightning-fs
 * volume: the git working copy.
 *
 * The single-volume rule is the point, not an implementation detail. lightning-fs
 * supports several named stores, so a git checkout in one and a scratch area in
 * another is a two-line mistake that yields an agent whose `grep` and whose
 * `read` disagree about what exists. Everything here — Pi's file tools, the
 * shell allowlist, and `isomorphic-git` — binds this one `fs`.
 *
 * `Shell` refuses **as a value** rather than throwing: `Result` makes "no shell
 * here" an ordinary outcome the agent can read, and `createBashTool` is simply
 * never registered, so the model is never offered a capability that does not
 * exist.
 */
import {
	ExecutionError,
	FileError,
	type ExecutionEnv,
	type FileInfo,
	type Result,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { createAllowlistShell } from "./shell";

/** The subset of lightning-fs (and any node-fs-alike promises API) we rely on. */
export interface PromiseFs {
	readFile(path: string, opts?: { encoding?: "utf8" }): Promise<string | Uint8Array>;
	writeFile(path: string, data: string | Uint8Array, opts?: { encoding?: "utf8" }): Promise<void>;
	unlink(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	mkdir(path: string): Promise<void>;
	rmdir(path: string): Promise<void>;
	stat(path: string): Promise<{ size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
	lstat(path: string): Promise<{ size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
	readlink?(path: string): Promise<string>;
}

const ok = <T>(value: T): Result<T, FileError> => ({ ok: true, value });
const fail = (code: FileError["code"], message: string, path?: string): Result<never, FileError> =>
	({ ok: false, error: new FileError(code, message, path) });

/** lightning-fs surfaces POSIX-ish codes on the error object; map what we can
 * and fall back rather than inventing a code we cannot justify. */
function toFileError(err: unknown, path: string): Result<never, FileError> {
	const code = (err as { code?: string })?.code;
	if (code === "ENOENT") return fail("not_found", `No such file or directory: ${path}`, path);
	if (code === "ENOTDIR") return fail("not_directory", `Not a directory: ${path}`, path);
	if (code === "EISDIR") return fail("is_directory", `Is a directory: ${path}`, path);
	if (code === "EACCES" || code === "EPERM") return fail("permission_denied", `Permission denied: ${path}`, path);
	return fail("unknown", (err as Error)?.message ?? String(err), path);
}

function normalize(cwd: string, path: string): string {
	const joined = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
	const parts: string[] = [];
	for (const seg of joined.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return `/${parts.join("/")}`;
}

const decoder = new TextDecoder();

export interface BrowserExecutionEnvOptions {
	fs: PromiseFs;
	/** Repo root; the agent's working directory. */
	cwd?: string;
	/** Scratch space is a PATH inside the one tree, never a second filesystem. */
	tmpDir?: string;
	/**
	 * Enable the read-only command allowlist behind `exec` (see `./shell`).
	 *
	 * Off by default, and that default is the honest one: with no shell the
	 * refusal below is true, and a host that has not yet decided to offer
	 * composition should not silently acquire it. When enabled, register
	 * `createBashTool` and put {@link allowlistSummary} in its description --
	 * the boundary works by being stated, not by being discovered.
	 */
	shell?: boolean;
}

export function createBrowserExecutionEnv(options: BrowserExecutionEnvOptions): ExecutionEnv {
	const fs = options.fs;
	const cwd = options.cwd ?? "/repo";
	const tmpDir = options.tmpDir ?? `${cwd}/.tmp`;
	const allowlistExec = options.shell ? createAllowlistShell({ fs, cwd }) : null;
	let tempSeq = 0;

	const abs = (p: string) => normalize(cwd, p);

	async function info(path: string): Promise<Result<FileInfo, FileError>> {
		const p = abs(path);
		try {
			const st = await fs.lstat(p);
			return ok({
				name: p.split("/").pop() ?? p,
				path: p,
				kind: st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file",
				size: st.size,
			} as FileInfo);
		} catch (err) {
			return toFileError(err, p);
		}
	}

	async function readText(path: string): Promise<Result<string, FileError>> {
		const p = abs(path);
		try {
			const data = await fs.readFile(p, { encoding: "utf8" });
			return ok(typeof data === "string" ? data : decoder.decode(data));
		} catch (err) {
			return toFileError(err, p);
		}
	}

	/** Create parents as needed; lightning-fs mkdir is single-level. */
	async function mkdirp(dir: string): Promise<void> {
		const parts = dir.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur += `/${part}`;
			try {
				await fs.mkdir(cur);
			} catch {
				/* already exists */
			}
		}
	}

	const env: ExecutionEnv = {
		cwd,

		async absolutePath(path) {
			return ok(abs(path));
		},
		async joinPath(parts) {
			return ok(normalize(cwd, parts.join("/")));
		},
		async canonicalPath(path) {
			// No symlink resolution: lightning-fs support is optional and a wrong
			// answer here is worse than an honest syntactic one.
			return ok(abs(path));
		},
		readTextFile: (path) => readText(path),
		async readTextLines(path, opts) {
			const res = await readText(path);
			if (!res.ok) return res;
			const lines = res.value.split("\n");
			return ok(opts?.maxLines != null ? lines.slice(0, opts.maxLines) : lines);
		},
		async readBinaryFile(path) {
			const p = abs(path);
			try {
				const data = await fs.readFile(p);
				return ok(typeof data === "string" ? new TextEncoder().encode(data) : data);
			} catch (err) {
				return toFileError(err, p);
			}
		},
		async writeFile(path, content) {
			const p = abs(path);
			try {
				await mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
				await fs.writeFile(p, content as never, typeof content === "string" ? { encoding: "utf8" } : undefined);
				return ok(undefined);
			} catch (err) {
				return toFileError(err, p);
			}
		},
		async appendFile(path, content) {
			const existing = await readText(path);
			const prefix = existing.ok ? existing.value : "";
			const text = typeof content === "string" ? content : decoder.decode(content);
			return env.writeFile(path, prefix + text);
		},
		fileInfo: (path) => info(path),
		async listDir(path) {
			const p = abs(path);
			try {
				const names = await fs.readdir(p);
				const out: FileInfo[] = [];
				for (const name of names) {
					const child = await info(`${p}/${name}`);
					if (child.ok) out.push(child.value);
				}
				return ok(out);
			} catch (err) {
				return toFileError(err, p);
			}
		},
		async exists(path) {
			const res = await info(path);
			if (res.ok) return ok(true);
			// Missing is `false`; anything else is a real error, per the contract.
			return res.error.code === "not_found" ? ok(false) : res;
		},
		async createDir(path) {
			const p = abs(path);
			try {
				await mkdirp(p);
				return ok(undefined);
			} catch (err) {
				return toFileError(err, p);
			}
		},
		async remove(path, opts) {
			const p = abs(path);
			try {
				const st = await fs.lstat(p);
				if (st.isDirectory()) {
					if ((opts as { recursive?: boolean } | undefined)?.recursive) {
						for (const name of await fs.readdir(p)) await env.remove(`${p}/${name}`, opts);
					}
					await fs.rmdir(p);
				} else {
					await fs.unlink(p);
				}
				return ok(undefined);
			} catch (err) {
				return toFileError(err, p);
			}
		},
		async createTempDir(prefix) {
			const p = `${tmpDir}/${prefix ?? "tmp"}-${++tempSeq}`;
			await mkdirp(p);
			return ok(p);
		},
		async createTempFile(opts) {
			const name = `${(opts as { prefix?: string } | undefined)?.prefix ?? "tmp"}-${++tempSeq}`;
			const p = `${tmpDir}/${name}`;
			await mkdirp(tmpDir);
			await fs.writeFile(p, "", { encoding: "utf8" });
			return ok(p);
		},

		// -- Shell: the allowlist when enabled, else refuses as a value ------
		async exec(command: string, _options?: ShellExecOptions) {
			if (allowlistExec) return allowlistExec(command);
			// `shell_unavailable` is Pi's own code for exactly this, so the
			// refusal is a first-class outcome rather than an invented one.
			return {
				ok: false,
				error: new ExecutionError(
					"shell_unavailable",
					`No shell in a browser compartment, so \`${command.split(/\s+/)[0]}\` cannot run. ` +
						"Use the file tools for reading and editing, the git tool for version control, " +
						"the yoars tool for platform calls, or dispatch to a nest for anything needing a real machine.",
				),
			};
		},
		async cleanup() {
			/* nothing held open */
		},
	};

	return env;
}
