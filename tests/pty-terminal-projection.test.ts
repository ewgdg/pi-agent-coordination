import assert from "node:assert/strict";
import test from "node:test";

import {
	spawnPtyTerminalProjection,
	type PtyTerminalProjection,
} from "../src/process-runtime/pty-terminal-projection.ts";

const TEST_TIMEOUT_MS = 10_000;

async function spawnNodeScript(
	script: string,
	columns = 24,
	rows = 6,
): Promise<PtyTerminalProjection> {
	return spawnPtyTerminalProjection({
		file: process.execPath,
		arguments: ["-e", script],
		cwd: process.cwd(),
		environment: { ...process.env, TERM: "xterm-256color" },
		columns,
		rows,
	});
}

test("real PTY output is parsed into styled cells, cursor, and dimensions before exit resolves", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdout.write("\x1b[2J\x1b[Hplain\x1b[2;3H\x1b[1;3;4;38;2;12;34;56;48;5;123mX\x1b[0m\x1b[4;6H");
	`);

	const exit = await projection.exited;
	const frame = projection.frame();
	assert.deepEqual(exit, { exitCode: 0, signal: 0 });
	assert.equal(frame.columns, 24);
	assert.equal(frame.rows, 6);
	assert.equal(frame.lines[0]?.text, "plain");
	assert.deepEqual(frame.cursor, { column: 5, row: 3 });
	assert.equal(frame.buffer, "normal");
	assert.deepEqual(frame.lines[1]?.cells[2], {
		text: "X",
		width: 1,
		style: {
			foreground: { kind: "rgb", red: 12, green: 34, blue: 56 },
			background: { kind: "indexed", index: 123 },
			bold: true,
			dim: false,
			italic: true,
			underline: true,
			blink: false,
			inverse: false,
			invisible: false,
			strikethrough: false,
			overline: false,
		},
	});

	await projection.dispose();
	await projection.dispose();
	assert.equal(projection.disposed, true);
	assert.throws(() => projection.frame(), /disposed/);
});

test("user input is written to the real PTY byte-for-byte", { timeout: TEST_TIMEOUT_MS }, async () => {
	const input = "A\x1b[B\r\x1b[200~paste\ntext\x1b[201~";
	const expectedBytes = Buffer.from(input).length;
	const projection = await spawnNodeScript(String.raw`
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdout.write("READY");
		let input = Buffer.alloc(0);
		process.stdin.on("data", chunk => {
			input = Buffer.concat([input, chunk]);
			if (input.length >= ${expectedBytes}) {
				process.stdout.write("\x1b[2J\x1b[HINPUT_HEX=" + input.toString("hex"));
				process.exit(0);
			}
		});
	`, 100, 6);
	await waitForText(projection, "READY");

	projection.writeInput(input);
	await projection.exited;
	assert.equal(
		projection.frame().lines[0]?.text,
		`INPUT_HEX=${Buffer.from(input).toString("hex")}`,
	);
	await projection.dispose();
});

test("xterm-generated terminal replies use a separate PTY write path", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.once("data", reply => {
			process.stdout.write("\x1b[2J\x1b[HREPLY_HEX=" + reply.toString("hex"));
			process.exit(0);
		});
		process.stdout.write("\x1b[3;5H\x1b[6n");
	`);

	await projection.exited;
	assert.equal(
		projection.frame().lines[0]?.text,
		`REPLY_HEX=${Buffer.from("\u001b[3;5R").toString("hex")}`,
	);
	await projection.dispose();
});

test("resize updates xterm before notifying the real PTY", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdout.write("READY");
		process.on("SIGWINCH", () => {
			process.stdout.write("\x1b[2J\x1b[HPTY_SIZE=" + process.stdout.columns + "x" + process.stdout.rows);
			process.exit(0);
		});
		process.stdin.resume();
	`);
	await waitForText(projection, "READY");

	projection.resize(40, 9);
	assert.deepEqual(
		{ columns: projection.frame().columns, rows: projection.frame().rows },
		{ columns: 40, rows: 9 },
	);

	await projection.exited;
	assert.equal(projection.frame().lines[0]?.text, "PTY_SIZE=40x9");
	await projection.dispose();
});

async function waitForText(
	projection: PtyTerminalProjection,
	text: string,
): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await projection.drain();
		if (projection.frame().lines.some((line) => line.text.includes(text))) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Terminal projection did not render ${JSON.stringify(text)}`);
}
