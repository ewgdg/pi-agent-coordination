import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";

const SCRIPT = "/usr/bin/script";
const PTY_WAIT_TIMEOUT_MS = 20_000;
const SCREEN_POLL_INTERVAL_MS = 10;
const FIXTURE = fileURLToPath(
	new URL("./fixtures/coordinated-workflow-pty-fixture.ts", import.meta.url),
);
const FAILURE_FIXTURE = fileURLToPath(
	new URL("./fixtures/agent-view-failure-pty-fixture.ts", import.meta.url),
);
const DIRECT_AGENT_INPUT = "direct input through child editor";

test("real fullscreen PTY /agents view mouse-scrolls and returns to the exact Owner", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		const setup = await terminal.marker<{
			ownerId: string;
			childAgentId: string;
			cwd: string;
			ownerEditorText: string;
		}>("__PTY_AGENT_VIEW_SETUP__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("j");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Viewed Worker") &&
				line.includes(setup.childAgentId.slice(-8)) &&
				line.includes("Live")
			) && frame.some((line) => line.includes("Viewed child transcript line 59"))
		);
		const agentViewFrame = await terminal.screen();
		assert.equal(agentViewFrame.length, 24);
		assert.equal(
			agentViewFrame.some((line) => line.includes(setup.ownerEditorText)),
			false,
		);
		assert.equal(agentViewFrame.some((line) => line.includes("deterministic-owner")), true);
		for (let notch = 0; notch < 6; notch += 1) {
			terminal.write("\x1b[<64;10;8M");
		}
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 3")) &&
			!frame.some((line) => line.includes("Viewed child transcript line 59"))
		);
		terminal.write("\x1b[F");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59"))
		);
		terminal.write("\x1b[<0;80;17M");
		terminal.write("\x1b[<32;80;3M");
		terminal.write("\x1b[<0;80;3m");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("pi v0.84.0")) &&
			!frame.some((line) => line.includes("Viewed child transcript line 59"))
		);
		terminal.write("\x1b[F");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59"))
		);

		for (const character of DIRECT_AGENT_INPUT) terminal.write(character);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(DIRECT_AGENT_INPUT))
		);
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Streaming child update 00")) &&
			frame.some((line) => line.includes("Working"))
		);
		for (let notch = 0; notch < 6; notch += 1) {
			terminal.write("\x1b[<64;10;8M");
		}
		const inspectedStreamingFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line")) &&
			!frame.some((line) => line.includes("Streaming child update 39"))
		);
		const inspectedStreamingAnchor = inspectedStreamingFrame.find((line) =>
			line.includes("Viewed child transcript line")
		)?.trim();
		assert.ok(inspectedStreamingAnchor);
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");
		const settledAwayFromTail = await terminal.screen();
		assert.equal(
			settledAwayFromTail.some((line) => line.trim() === inspectedStreamingAnchor),
			true,
		);
		assert.equal(
			settledAwayFromTail.some((line) => line.includes("Streaming child update 39")),
			false,
		);
		terminal.write("\x1b[F");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Streaming child update 39"))
		);
		terminal.write("/agents");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("/agents"))
		);
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("k");
		terminal.write("\r");
		await terminal.waitFor("__PTY_AGENT_VIEW_CLOSED__");
		const ownerFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText))
		);
		assert.equal(
			ownerFrame.some((line) => line.includes("PTY Viewed Worker") && line.includes("Live")),
			false,
		);
		assert.equal(ownerFrame.some((line) => line.includes(setup.cwd)), true);
		assert.equal(
			ownerFrame.some((line) =>
				line.includes("/16k") && line.includes("deterministic-owner")
			),
			true,
		);

		await terminal.closed();
		assert.match(terminal.output(), /__PTY_AGENT_VIEW_CLOSED__/);
	} finally {
		terminal.kill();
	}
});

for (const failureKind of ["input", "render"] as const) {
	test(`real fullscreen PTY returns to Owner after child ${failureKind} failure`, {
		skip: !existsSync(SCRIPT),
	}, async () => {
		const terminal = launchFixture(FAILURE_FIXTURE, {
			PTY_AGENT_VIEW_FAILURE: failureKind,
		});
		try {
			const setup = await terminal.marker<{
				childAgentId: string;
				ownerEditorText: string;
			}>("__PTY_AGENT_VIEW_FAILURE_SETUP__");
			await terminal.waitForScreen((frame) =>
				frame.some((line) => line.includes("PTY Failure Worker")) &&
				frame.some((line) => line.includes("Tab views"))
			);
			terminal.write("j");
			terminal.write("\r");
			await terminal.waitForScreen((frame) =>
				frame.some((line) =>
					line.includes("PTY Failure Worker") &&
					line.includes(setup.childAgentId.slice(-8)) &&
					line.includes("Live")
				)
			);
			terminal.write("x");
			await terminal.waitFor(`__PTY_AGENT_VIEW_FAILURE_RESTORED__${failureKind}`);
			const ownerFrame = await terminal.waitForScreen((frame) =>
				frame.some((line) => line.includes("Owner failure baseline remains mounted")) &&
				frame.some((line) => line.includes(setup.ownerEditorText))
			);
			assert.equal(
				ownerFrame.some((line) => line.includes("PTY Failure Worker")),
				false,
			);
			await terminal.closed();
		} finally {
			terminal.kill();
		}
	});
}

test("real fullscreen PTY replaces selected initialization failure with Dormant", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FAILURE_FIXTURE, {
		PTY_AGENT_VIEW_FAILURE: "initialization",
	});
	try {
		const setup = await terminal.marker<{ ownerEditorText: string }>(
			"__PTY_AGENT_VIEW_FAILURE_SETUP__",
		);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Failure Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("j");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Failure Worker") && line.includes("Live")
			)
		);
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Failure Worker") && line.includes("Dormant")
			)
		);
		terminal.write("/agents");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("\t");
		terminal.write("\r");
		await terminal.waitFor("__PTY_AGENT_VIEW_FAILURE_RESTORED__initialization");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner failure baseline remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText))
		);
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY replaces a terminally failed selected Run with Dormant", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FAILURE_FIXTURE, {
		PTY_AGENT_VIEW_FAILURE: "run",
	});
	try {
		const setup = await terminal.marker<{
			childAgentId: string;
			ownerEditorText: string;
		}>("__PTY_AGENT_VIEW_FAILURE_SETUP__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Failure Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("j");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Failure Worker") &&
				line.includes(setup.childAgentId.slice(-8)) &&
				line.includes("Live")
			)
		);
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Failure Worker") && line.includes("Dormant")
			) && frame.some((line) => line.includes("Deterministic PTY terminal Run failure"))
		);
		terminal.write("/agents");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("\t");
		terminal.write("\r");
		await terminal.waitFor("__PTY_AGENT_VIEW_FAILURE_RESTORED__run");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner failure baseline remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText))
		);
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY disposes an unviewed child mode exactly once", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FAILURE_FIXTURE, {
		PTY_AGENT_VIEW_FAILURE: "noninteractive",
	});
	try {
		await terminal.waitFor("__PTY_NONINTERACTIVE_DISPOSAL_COMPLETE__");
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY switches one mounted view between two Agent modes", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		const setup = await terminal.marker<{
			childAgentId: string;
			secondChildAgentId: string;
			ownerEditorText: string;
		}>("__PTY_AGENT_VIEW_SETUP__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("j");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Viewed Worker") &&
				line.includes(setup.childAgentId.slice(-8))
			)
		);
		for (const character of DIRECT_AGENT_INPUT) terminal.write(character);
		terminal.write("\r");
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");

		terminal.write("/agents");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("j");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Second Worker") &&
				line.includes(setup.secondChildAgentId.slice(-8)) &&
				line.includes("Live")
			) && frame.some((line) =>
				line.includes("Second PTY child remains independently interactive")
			)
		);

		terminal.write("/agents");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("k");
		terminal.write("k");
		terminal.write("\r");
		await terminal.waitFor("__PTY_AGENT_VIEW_CLOSED__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText))
		);
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY reflows the complete Agent view at 100x30", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FIXTURE, {
		PTY_TEST_COLUMNS: "100",
		PTY_TEST_ROWS: "30",
	});
	try {
		const setup = await terminal.marker<{
			childAgentId: string;
			ownerEditorText: string;
			terminalColumns: number;
			terminalRows: number;
		}>("__PTY_AGENT_VIEW_SETUP__");
		assert.deepEqual(
			{ columns: setup.terminalColumns, rows: setup.terminalRows },
			{ columns: 100, rows: 30 },
		);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("j");
		terminal.write("\r");
		const agentFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("PTY Viewed Worker") &&
				line.includes(setup.childAgentId.slice(-8))
			) && frame.some((line) => line.includes("Viewed child transcript line 59"))
		);
		assert.equal(agentFrame.length, 30);
		for (const character of DIRECT_AGENT_INPUT) terminal.write(character);
		terminal.write("\r");
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");
		terminal.write("/agents");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("k");
		terminal.write("\r");
		await terminal.waitFor("__PTY_AGENT_VIEW_CLOSED__");
		const ownerFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText))
		);
		assert.equal(ownerFrame.length, 30);
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

function launchFixture(
	fixture = FIXTURE,
	environment: Readonly<Record<string, string>> = {},
) {
	const command = `${quoteShell(process.execPath)} ${quoteShell(fixture)}`;
	const child = spawn(
		SCRIPT,
		["-q", "-e", "-f", "-c", command, "/dev/null"],
		{
			env: {
				...process.env,
				PI_OFFLINE: "1",
				TERM: "xterm-256color",
				...environment,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	return new PtyFixture(
		child,
		Number(environment.PTY_TEST_COLUMNS) || 80,
		Number(environment.PTY_TEST_ROWS) || 24,
	);
}

class PtyFixture {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #columns: number;
	readonly #rows: number;
	#output = "";
	readonly #closed: Promise<void>;

	constructor(child: ChildProcessWithoutNullStreams, columns: number, rows: number) {
		this.#child = child;
		this.#columns = columns;
		this.#rows = rows;
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
			cols: this.#columns,
			rows: this.#rows,
			scrollback: 1_000,
		});
		await new Promise<void>((resolve) => terminal.write(this.#output, resolve));
		const buffer = terminal.buffer.active;
		return Array.from({ length: this.#rows }, (_value, index) =>
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

	async waitForScreen(predicate: (frame: readonly string[]) => boolean): Promise<string[]> {
		const initialFrame = await this.screen();
		if (predicate(initialFrame)) return initialFrame;
		return new Promise<string[]>((resolve, reject) => {
			let checking = false;
			let poll: ReturnType<typeof setInterval> | undefined;
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for a matching PTY screen\n${this.#output}`));
			}, PTY_WAIT_TIMEOUT_MS);
			const inspect = () => {
				if (checking) return;
				checking = true;
				void this.screen().then((frame) => {
					checking = false;
					if (!predicate(frame)) return;
					cleanup();
					resolve(frame);
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
				if (poll !== undefined) clearInterval(poll);
				clearTimeout(timeout);
				this.#child.stdout.off("data", inspect);
				this.#child.stderr.off("data", inspect);
				this.#child.off("close", closed);
			};
			this.#child.stdout.on("data", inspect);
			this.#child.stderr.on("data", inspect);
			this.#child.once("close", closed);
			poll = setInterval(inspect, SCREEN_POLL_INTERVAL_MS);
			inspect();
		});
	}

	async waitFor(value: string): Promise<void> {
		if (this.#output.includes(value)) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${JSON.stringify(value)}\n${this.#output}`));
			}, PTY_WAIT_TIMEOUT_MS);
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
