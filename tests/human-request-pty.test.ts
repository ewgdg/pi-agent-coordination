import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = "/usr/bin/script";
const FIXTURE = fileURLToPath(
	new URL("./fixtures/human-request-pty-fixture.ts", import.meta.url),
);

test("a background multi-Question Request preserves the occupied native editor", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture("submit");
	try {
		await terminal.waitFor("Attention Inbox");
		terminal.write("Z");
		terminal.write("\x1bh");
		await terminal.waitFor("Architecture");
		await terminal.waitFor("Validation");
		await terminal.waitFor("Rationale");

		terminal.write("\r");
		terminal.write("PTY");
		terminal.write("\r");
		terminal.write("\x1b[Z");
		terminal.write(" rationale");
		terminal.write("\t");
		terminal.write("\x1b[Z");
		terminal.write("\r");
		terminal.write(" ");
		terminal.write("\r");

		const result = await terminal.result();
		assert.deepEqual(result, {
			kind: "submit",
			editorText: "native draftZ",
			answers: [
				{ kind: "select_one", selectedOptionIndex: 0 },
				{ kind: "text", text: "PTY rationale" },
				{ kind: "select_many", selectedOptionIndexes: [0] },
			],
		});
	} finally {
		terminal.kill();
	}
});

test("Escape closes the Request surface and restores the occupied native editor", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture("interrupt");
	try {
		await terminal.waitFor("Attention Inbox");
		terminal.write("Z");
		terminal.write("\x1bh");
		await terminal.waitFor("Interrupt");
		terminal.write("\x1b");

		assert.deepEqual(await terminal.result(), {
			kind: "interrupt",
			editorText: "native draftZ",
		});
	} finally {
		terminal.kill();
	}
});

type FixtureResult =
	| Readonly<{
		kind: "submit";
		editorText: string;
		answers: readonly unknown[];
	}>
	| Readonly<{
		kind: "interrupt";
		editorText: string;
	}>;

function launchFixture(mode: "submit" | "interrupt") {
	const command = `${quoteShell(process.execPath)} ${quoteShell(FIXTURE)} ${mode}`;
	const child = spawn(
		SCRIPT,
		["-q", "-e", "-f", "-c", command, "/dev/null"],
		{
			env: {
				...process.env,
				PI_OFFLINE: "1",
				TERM: "xterm-256color",
			},
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

	async waitFor(value: string): Promise<void> {
		if (this.#output.includes(value)) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${JSON.stringify(value)}\n${this.#output}`));
			}, 10_000);
			const inspect = () => {
				if (!this.#output.includes(value)) return;
				cleanup();
				resolve();
			};
			const cleanup = () => {
				clearTimeout(timeout);
				this.#child.stdout.off("data", inspect);
				this.#child.stderr.off("data", inspect);
				this.#child.off("close", closed);
			};
			const closed = () => {
				if (this.#output.includes(value)) {
					cleanup();
					resolve();
					return;
				}
				cleanup();
				reject(new Error(
					`PTY fixture closed before ${JSON.stringify(value)} appeared\n${this.#output}`,
				));
			};
			this.#child.stdout.on("data", inspect);
			this.#child.stderr.on("data", inspect);
			this.#child.once("close", closed);
		});
	}

	async result(): Promise<FixtureResult> {
		await this.#closed;
		const match = /__PTY_RESULT__(\{[^\r\n]+\})/.exec(this.#output);
		if (!match) throw new Error(`PTY fixture produced no result marker\n${this.#output}`);
		return JSON.parse(match[1]!) as FixtureResult;
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
