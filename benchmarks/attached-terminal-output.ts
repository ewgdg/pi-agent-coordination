import { performance } from "node:perf_hooks";

import { spawnPtyTerminalProjection } from "../src/process-runtime/pty-terminal-projection.ts";

const BURST_REPETITIONS = 150_000;
const RAW_TAIL_LENGTH = 256;
const COLUMNS = 120;
const ROWS = 40;

const childScript = String.raw`
process.stdin.setRawMode(true);
process.stdin.resume();
const frame = "\x1b[2J\x1b[H\x1b[38;5;123mFRAME_0123456789abcdef\x1b[0m";
process.stdin.on("data", input => {
	const marker = input.toString();
	for (let index = 0; index < ${BURST_REPETITIONS}; index += 1) {
		process.stdout.write(frame);
	}
	process.stdout.write("DONE_" + marker);
});
process.stdout.write("READY");
`;

const projection = spawnPtyTerminalProjection({
	file: process.execPath,
	arguments: ["-e", childScript],
	environment: { ...process.env, TERM: "xterm-256color" },
	columns: COLUMNS,
	rows: ROWS,
});
let rawTail = "";
let rawWaiter: Readonly<{ marker: string; resolve(): void }> | undefined;
projection.addOutputHandler((data) => {
	rawTail = (rawTail + data).slice(-RAW_TAIL_LENGTH);
	if (!rawWaiter || !rawTail.includes(rawWaiter.marker)) return;
	const { resolve } = rawWaiter;
	rawWaiter = undefined;
	resolve();
});

try {
	await waitForRaw("READY");
	await projection.drain();
	const headlessParsingMs = await measureBurst("HEADLESS");
	await projection.enterPhysicalTerminalMode();
	const physicalBypassMs = await measureBurst("PHYSICAL");
	console.log(JSON.stringify({
		burstRepetitions: BURST_REPETITIONS,
		headlessParsingMs,
		physicalBypassMs,
		speedup: headlessParsingMs / physicalBypassMs,
	}, undefined, 2));
} finally {
	await projection.dispose();
}

async function measureBurst(marker: string): Promise<number> {
	rawTail = "";
	const startedAt = performance.now();
	projection.writeInput(marker);
	await waitForRaw(`DONE_${marker}`);
	await projection.drain();
	return performance.now() - startedAt;
}

function waitForRaw(marker: string): Promise<void> {
	if (rawTail.includes(marker)) return Promise.resolve();
	if (rawWaiter) throw new Error("benchmark_raw_wait_already_pending");
	return new Promise((resolve) => {
		rawWaiter = { marker, resolve };
	});
}
