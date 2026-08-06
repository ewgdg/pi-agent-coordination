import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";

const SCRIPT = "/usr/bin/script";
const FIXTURE = fileURLToPath(
	new URL("./fixtures/coordinated-workflow-pty-fixture.ts", import.meta.url),
);

test("one native PTY spans the coordinated Workflow and containing-process shutdown", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		const setup = await terminal.marker<{
			ownerId: string;
			liveAgentId: string;
			dormantAgentId: string;
			cwd: string;
		}>("__PTY_SETUP__");
		await terminal.waitFor("Worker Live");
		const liveFrame = await terminal.screen();
		assert.equal(liveFrame.some((line) => /^┌─+┐$/.test(line)), true);
		assert.equal(
			liveFrame.some((line) => /^│.*Live.*Dormant.*│$/.test(line)),
			true,
		);
		assert.equal(
			liveFrame.some((line) => /^│.*children.*parent.*│$/.test(line)),
			true,
		);
		assert.equal(liveFrame.some((line) => /^└─+┘$/.test(line)), true);
		terminal.write("\t");
		await terminal.waitFor("Worker Dormant");
		terminal.write("\r");
		await terminal.waitFor("__PTY_SELECTED_DORMANT__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Worker Dormant · "))
		);
		const selectedDormantFrame = await terminal.screen();
		assertSelectedAgentFooterStatus(
			selectedDormantFrame,
			"Worker Dormant",
			setup.dormantAgentId,
			"Dormant",
		);
		assertNativeFooterPreserved(selectedDormantFrame, setup.cwd);
		terminal.write("selected dormant native input");
		await terminal.waitFor("selected dormant native input");
		terminal.write("\r");
		await terminal.waitFor("__PTY_SELECTED_RUN_FAILED__");
		assertSelectedAgentFooterStatus(
			await terminal.screen(),
			"Worker Dormant",
			setup.dormantAgentId,
			"Dormant",
		);
		terminal.write("native input after selected Run failure");
		await terminal.waitFor("native input after selected Run failure");
		terminal.write("\r");
		await terminal.waitFor("__PTY_DORMANT_INPUT_COMMITTED__");
		await terminal.waitFor("Worker Dormant");
		terminal.write("k");
		terminal.write("\r");
		await terminal.waitFor("__PTY_SELECTED_LIVE__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Worker Live · "))
		);
		const selectedLiveFrame = await terminal.screen();
		assertSelectedAgentFooterStatus(
			selectedLiveFrame,
			"Worker Live",
			setup.liveAgentId,
			"active",
		);
		terminal.write("selected native input");
		await terminal.waitFor("selected native input");
		terminal.write("\r");
		await terminal.waitFor("Escape checkpoint");
		terminal.write("\x1b");
		await terminal.waitFor("__PTY_HUMAN_ESCAPED__");

		terminal.write("k");
		await terminal.waitFor(setup.ownerId);
		terminal.write("\r");
		await terminal.waitFor("__PTY_ROUND_TRIPS__");
		await terminal.waitFor("__PTY_ATTENTION_READY__");
		await terminal.waitFor("ATTENTION 1");
		terminal.write("\x1b");
		await terminal.waitFor("Operational Attention · 1");

		await terminal.closed();
		assert.match(terminal.output(), /__PTY_ROUND_TRIPS__/);
		assert.match(terminal.output(), /__PTY_ATTENTION_READY__/);
	} finally {
		terminal.kill();
	}
});

function assertSelectedAgentFooterStatus(
	frame: readonly string[],
	label: string,
	agentId: string,
	phase: string,
): void {
	const marker = phase === "active" ? "● " : phase === "Dormant" ? "○ " : "";
	const prefix = `${marker}${label} · `;
	const suffix = ` · ${phase}`;
	const matchingLines = frame.filter((line) =>
		line.startsWith(prefix) && line.includes(suffix)
	);
	assert.equal(matchingLines.length, 1);
	const statusLine = matchingLines[0]!;
	const phaseIndex = statusLine.indexOf(suffix, prefix.length);
	const compactIdentity = statusLine.slice(prefix.length, phaseIndex);
	assert.ok(compactIdentity.length < agentId.length);
	assert.ok(agentId.endsWith(compactIdentity));
	assert.ok(frame.indexOf(statusLine) >= frame.length - 3);
}

function assertNativeFooterPreserved(frame: readonly string[], cwd: string): void {
	const cwdLine = frame.findIndex((line) => line.includes(cwd));
	const nativeStatsLine = frame.findIndex((line) =>
		line.includes("/16k") && line.includes("deterministic-owner")
	);
	const extensionStatusLine = frame.find((line) => line.includes("Native Peer"));
	assert.ok(cwdLine >= 0, JSON.stringify(frame));
	assert.ok(nativeStatsLine > cwdLine, JSON.stringify(frame));
	assert.ok(extensionStatusLine, JSON.stringify(frame));
	assert.ok(frame.indexOf(extensionStatusLine) > nativeStatsLine);
	assert.ok(extensionStatusLine.indexOf("Native Peer") > extensionStatusLine.indexOf("Dormant"));
}

function launchFixture() {
	const command = `${quoteShell(process.execPath)} ${quoteShell(FIXTURE)}`;
	const child = spawn(
		SCRIPT,
		["-q", "-e", "-f", "-c", command, "/dev/null"],
		{
			env: { ...process.env, PI_OFFLINE: "1", TERM: "xterm-256color" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	return new PtyFixture(child);
}

class PtyFixture {
	readonly #child: ChildProcessWithoutNullStreams;
	#output = "";
	readonly #closed: Promise<void>;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		child.stdout.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
		this.#closed = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else reject(new Error(
					`PTY fixture exited with ${code ?? signal ?? "unknown status"}\n${this.#output}`,
				));
			});
		});
		void this.#closed.catch(() => undefined);
	}

	write(value: string): void {
		this.#child.stdin.write(value);
	}

	output(): string {
		return this.#output;
	}

	async screen(): Promise<string[]> {
		const terminal = new xtermHeadless.Terminal({
			allowProposedApi: true,
			cols: 80,
			rows: 24,
			scrollback: 1_000,
		});
		await new Promise<void>((resolve) => terminal.write(this.#output, resolve));
		const buffer = terminal.buffer.active;
		return Array.from({ length: 24 }, (_value, index) =>
			buffer.getLine(buffer.viewportY + index)?.translateToString(true).trim() ?? ""
		);
	}

	closed(): Promise<void> {
		return this.#closed;
	}

	async marker<T>(prefix: string): Promise<T> {
		await this.waitFor(prefix);
		const match = new RegExp(`${prefix}(\\{[^\\r\\n]+\\})`).exec(this.#output);
		if (!match) throw new Error(`PTY marker ${prefix} has no JSON payload`);
		return JSON.parse(match[1]!) as T;
	}

	async waitForScreen(predicate: (frame: readonly string[]) => boolean): Promise<void> {
		if (predicate(await this.screen())) return;
		await new Promise<void>((resolve, reject) => {
			let checking = false;
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for a matching PTY screen\n${this.#output}`));
			}, 20_000);
			const inspect = () => {
				if (checking) return;
				checking = true;
				void this.screen().then((frame) => {
					checking = false;
					if (!predicate(frame)) return;
					cleanup();
					resolve();
				}).catch((error: unknown) => {
					checking = false;
					cleanup();
					reject(error);
				});
			};
			const closed = () => {
				cleanup();
				reject(new Error(`PTY fixture closed before a matching screen appeared\n${this.#output}`));
			};
			const cleanup = () => {
				clearTimeout(timeout);
				this.#child.stdout.off("data", inspect);
				this.#child.stderr.off("data", inspect);
				this.#child.off("close", closed);
			};
			this.#child.stdout.on("data", inspect);
			this.#child.stderr.on("data", inspect);
			this.#child.once("close", closed);
		});
	}

	async waitFor(value: string): Promise<void> {
		if (this.#output.includes(value)) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${JSON.stringify(value)}\n${this.#output}`));
			}, 20_000);
			const inspect = () => {
				if (!this.#output.includes(value)) return;
				cleanup();
				resolve();
			};
			const closed = () => {
				cleanup();
				reject(new Error(
					`PTY fixture closed before ${JSON.stringify(value)} appeared\n${this.#output}`,
				));
			};
			const cleanup = () => {
				clearTimeout(timeout);
				this.#child.stdout.off("data", inspect);
				this.#child.stderr.off("data", inspect);
				this.#child.off("close", closed);
			};
			this.#child.stdout.on("data", inspect);
			this.#child.stderr.on("data", inspect);
			this.#child.once("close", closed);
		});
	}

	kill(): void {
		if (this.#child.exitCode === null && this.#child.signalCode === null) {
			this.#child.kill("SIGTERM");
		}
	}
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
