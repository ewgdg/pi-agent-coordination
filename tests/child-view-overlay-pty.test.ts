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
	new URL("./fixtures/child-view-overlay-pty-fixture.ts", import.meta.url),
);

test("full-window child-view overlay covers the Owner TUI, closes on Escape, editor untouched", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		const setup = await terminal.marker<{
			ownerId: string;
			childAgentId: string;
			cwd: string;
		}>("__CV_SETUP__");
		// j moves the selector cursor onto the live child; Enter selects it
		// through the native swap path.
		terminal.write("j");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Overlay Worker"))
		);
		terminal.write("\r");
		await terminal.waitFor("__CV_SELECTED__");
		// The native swap path shows the child's transcript with the Owner's
		// native footer (cwd + extension status) before the overlay opens. Wait
		// for the clean post-selection frame — fixture markers print into the
		// PTY and can corrupt a half-rendered screen.
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(setup.cwd)) &&
			frame.some((line) => line.includes("Native Peer")) &&
			frame.some((line) => line.includes("Overlay Worker"))
		);
		const nativeFrame = await terminal.screen();
		assertNativeFooterVisible(nativeFrame, setup.cwd);

		// Open the overlay from the selected child's editor.
		terminal.write("/child-view\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("CHILD VIEW"))
		);
		const overlayFrame = await terminal.screen();
		assert.equal(
			overlayFrame[0]!.includes("CHILD VIEW"),
			true,
			JSON.stringify(overlayFrame),
		);
		// Full-window coverage: no Owner UI visible through any row — the native
		// footer, extension status, and editor content are all covered.
		assertNoNativeUiVisible(overlayFrame, setup.cwd);
		// The child's transcript renders read-only inside the overlay (the spawn
		// request arrives through the coordination message-delivery protocol, so
		// its custom entry is the child's transcript evidence here).
		assert.ok(
			overlayFrame.some((line) => line.includes("[agent-coordination.message-delivery]")),
			JSON.stringify(overlayFrame),
		);
		assert.ok(
			overlayFrame.some((line) => line.includes("child-view overlay")),
			JSON.stringify(overlayFrame),
		);

		// Input is captured by the overlay: typing must not reach the editor.
		terminal.write("swallowed by overlay");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const swallowedFrame = await terminal.screen();
		assert.equal(
			swallowedFrame.some((line) => line.includes("swallowed by overlay")),
			false,
			"overlay must capture input while open",
		);
		assert.equal(swallowedFrame[0]!.includes("CHILD VIEW"), true);

		// Escape closes the overlay; the native child view and footer return.
		terminal.write("\x1b");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(setup.cwd))
		);
		const restoredFrame = await terminal.screen();
		assertNativeFooterVisible(restoredFrame, setup.cwd);
		assert.equal(
			restoredFrame.some((line) => line.includes("CHILD VIEW")),
			false,
			"overlay must close on Escape",
		);

		// The native editor (pi-vim) is untouched: typing echoes normally.
		terminal.write("still native input");
		await terminal.waitFor("still native input");
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("still native input"))
		);
	} finally {
		terminal.kill();
	}
});

function assertNativeFooterVisible(frame: readonly string[], cwd: string): void {
	const cwdLine = frame.findIndex((line) => line.includes(cwd));
	const extensionStatusLine = frame.find((line) => line.includes("Native Peer"));
	assert.ok(cwdLine >= 0, JSON.stringify(frame));
	assert.ok(extensionStatusLine, JSON.stringify(frame));
	assert.ok(frame.indexOf(extensionStatusLine) > cwdLine);
}

function assertNoNativeUiVisible(frame: readonly string[], cwd: string): void {
	assert.equal(
		frame.some((line) => line.includes(cwd)),
		false,
		`native footer must be covered by the overlay:\n${frame.join("\n")}`,
	);
	assert.equal(
		frame.some((line) => line.includes("Native Peer")),
		false,
		`extension status must be covered by the overlay:\n${frame.join("\n")}`,
	);
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
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

	kill(): void {
		this.#child.kill();
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

	async waitFor(text: string): Promise<void> {
		await this.waitForScreen((frame) => frame.some((line) => line.includes(text)));
	}

	async waitForScreen(predicate: (frame: readonly string[]) => boolean): Promise<void> {
		if (predicate(await this.screen())) return;
		await new Promise<void>((resolve, reject) => {
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
		});
	}
}
