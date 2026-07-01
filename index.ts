/**
 * clj-paren-repair — Clojure delimiter repair extension for pi.
 *
 * Mirrors the behaviour of bhauman/clojure-mcp-light's hook:
 * - **write**  → check content before disk, auto-fix, **block** if unfixable
 * - **edit**   → backup before, auto-fix after, **restore** from backup if unfixable
 *
 * All heavy lifting (edamame parse + parinfer repair) is delegated to the
 * bundled Babashka script so we get the full Clojure ecosystem for free.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ── paths ────────────────────────────────────────────────────────────

const EXT_DIR = __dirname;
const REPAIR_BB = join(EXT_DIR, "repair.bb");

// ── clojure file detection ───────────────────────────────────────────

const CLJ_RE = /\.(clj|cljs|cljc|cljd|bb|lpy|edn)$/i;

function isClojureFile(path: string): boolean {
	return CLJ_RE.test(path);
}

// ── bb helper ────────────────────────────────────────────────────────

/**
 * Spawn `bb repair.bb`, pipe `input` through stdin, return stdout.
 * Throws on non-zero exit or spawn failure.
 */
function repair(input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("bb", [REPAIR_BB], {
			env: { ...process.env, BABASHKA_VERSION: "1.12.218" },
		});

		let stdout = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));

		const stderrChunks: string[] = [];
		child.stderr.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else
				reject(
					new Error(
						`bb repair.bb exited ${code}${stderrChunks.length ? ": " + stderrChunks.join("") : ""}`,
					),
				);
		});

		child.on("error", reject);
		child.stdin.end(input);
	});
}

// ── backup helpers ───────────────────────────────────────────────────

function backupPath(file: string): string {
	return join(tmpdir(), `clj-repair-${Date.now()}-${Math.random().toString(36).slice(2)}.bak`);
}

async function backup(file: string, dest: string): Promise<void> {
	await copyFile(file, dest);
}

async function restore(file: string, src: string): Promise<void> {
	await writeFile(file, await readFile(src));
}

async function cleanup(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch {
		/* ignore */
	}
}

// ── state ────────────────────────────────────────────────────────────

/** Map<toolCallId, backupPath> — populated on edit preflight, cleaned on result. */
const backups = new Map<string, string>();

// ── extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── session shutdown: clean stale backups ────────────────────────
	pi.on("session_shutdown", async () => {
		for (const bp of backups.values()) await cleanup(bp);
		backups.clear();
	});

	// ── tool_call: intercept write / edit on clojure files ──────────
	pi.on("tool_call", async (event, ctx) => {
		// ── write ───────────────────────────────────────────────────
		if (event.toolName === "write") {
			const input = event.input as { file_path?: string; path?: string; content?: string };
			const filePath = input.file_path ?? input.path;
			if (!filePath || !isClojureFile(filePath)) return;

			const content = input.content ?? "";
			try {
				const repaired = await repair(content);
				if (repaired !== content) {
					ctx.ui.notify("clj-paren-repair: fixed delimiters", "info");
				}
				// Mutate input in place so the write tool sees repaired content
				input.content = repaired;
			} catch {
				// bb crashed — block the write to be safe
				return {
					block: true,
					reason: `clj-paren-repair: could not verify Clojure source for "${filePath}" (bb error). Write blocked.`,
				};
			}
		}

		// ── edit ────────────────────────────────────────────────────
		if (event.toolName === "edit") {
			const input = event.input as { file_path?: string; path?: string };
			const filePath = input.file_path ?? input.path;
			if (!filePath || !isClojureFile(filePath)) return;

			const absPath = resolve(ctx.cwd, filePath);
			const bp = backupPath(absPath);
			try {
				await backup(absPath, bp);
				backups.set(event.toolCallId, bp);
			} catch {
				// File didn't exist yet — nothing to restore
			}
		}
	});

	// ── tool_result: fix edit results, restore on failure ───────────
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit") return;

		const backup = backups.get(event.toolCallId);
		if (!backup) return;

		const input = event.input as { file_path?: string; path?: string };
		const filePath = input.file_path ?? input.path;
		if (!filePath || !isClojureFile(filePath)) {
			await cleanup(backup);
			backups.delete(event.toolCallId);
			return;
		}

		const absPath = resolve(ctx.cwd, filePath);

		try {
			const fileContent = await readFile(absPath, "utf-8");
			const repaired = await repair(fileContent);

			if (repaired !== fileContent) {
				await writeFile(absPath, repaired);
				ctx.ui.notify("clj-paren-repair: fixed delimiters after edit", "info");
			}
			// Success — don't error the tool result
		} catch {
			// Repair failed — restore original and signal error to the LLM
			try {
				await restore(absPath, backup);
			} catch {
				/* best effort */
			}

			ctx.ui.notify(
				`clj-paren-repair: delimiter fix failed — restored "${filePath}" from backup`,
				"error",
			);

			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `clj-paren-repair: delimiter errors in "${filePath}" could not be auto-fixed. The file has been restored to its previous state. Please rewrite the edit with balanced delimiters.`,
					},
				],
			};
		} finally {
			await cleanup(backup);
			backups.delete(event.toolCallId);
		}
	});
}
