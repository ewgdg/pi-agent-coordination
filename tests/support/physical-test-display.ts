import xtermHeadless from "@xterm/headless";
import type { Component } from "@earendil-works/pi-tui";

export type PhysicalTestDisplay = Readonly<{
	view: Component;
	active(): boolean;
	dispose(): void;
}>;

/** A test-owned physical terminal: production routing still uses its normal stdio boundary. */
export function createPhysicalTestDisplay(onActive: (active: boolean) => void): PhysicalTestDisplay {
	const terminal = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	let active = false;
	const saved: Array<() => void> = [];
	const replace = (object: object, key: string, value: unknown) => {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		Object.defineProperty(object, key, { configurable: true, writable: true, value });
		saved.push(() => {
			if (descriptor) Object.defineProperty(object, key, descriptor);
			else Reflect.deleteProperty(object, key);
		});
	};
	replace(process.stdin, "isTTY", true);
	replace(process.stdout, "isTTY", true);
	replace(process.stdout, "columns", 80);
	replace(process.stdout, "rows", 24);
	replace(process.stdin, "isRaw", false);
	replace(process.stdin, "setRawMode", (raw: boolean) => {
		active = raw;
		process.stdin.isRaw = raw;
		onActive(raw);
		return process.stdin;
	});
	replace(process.stdin, "resume", () => process.stdin);
	replace(process.stdin, "pause", () => process.stdin);
	replace(process.stdout, "write", (data: string | Buffer, encodingOrCallback?: unknown, callback?: () => void) => {
		terminal.write(typeof data === "string" ? data : data.toString("utf8"));
		if (typeof encodingOrCallback === "function") encodingOrCallback();
		else callback?.();
		return true;
	});
	const input = (data: string) => {
		if (active) process.stdin.emit("data", data);
	};
	terminal.onData(input);
	return {
		active: () => active,
		view: {
			render: () => {
				const buffer = terminal.buffer.active;
				return Array.from({ length: terminal.rows }, (_, row) =>
					buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
			},
			handleInput: input,
			invalidate() {},
		},
		dispose() {
			for (const restore of saved.reverse()) restore();
			terminal.dispose();
		},
	};
}
