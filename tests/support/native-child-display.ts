import xtermHeadless from "@xterm/headless";

type NativeChild = Readonly<{
	dimensions(): Readonly<{ columns: number; rows: number }>;
	beginPhysicalTerminalAttachment(handler: (data: string) => void): Promise<() => void>;
	writeInput(data: string): void;
	exited: Promise<unknown>;
}>;

const displays = new WeakMap<NativeChild, InstanceType<typeof xtermHeadless.Terminal>>();

/** Tests that use native keyboard input must select a real display, not a hidden diagnostic screen. */
export async function attachNativeChildDisplay(child: NativeChild): Promise<void> {
	if (displays.has(child)) return;
	const dimensions = child.dimensions();
	const display = new xtermHeadless.Terminal({
		cols: dimensions.columns, rows: dimensions.rows, allowProposedApi: true,
	});
	displays.set(child, display);
	display.onData(data => child.writeInput(data));
	try {
		const disconnect = await child.beginPhysicalTerminalAttachment(data => {
			const current = child.dimensions();
			if (display.cols !== current.columns || display.rows !== current.rows) {
				display.resize(current.columns, current.rows);
			}
			display.write(data);
		});
		void child.exited.finally(() => {
			disconnect();
			displays.delete(child);
			display.dispose();
		});
	} catch (error) {
		displays.delete(child);
		display.dispose();
		throw error;
	}
}

export function nativeChildDisplayText(child: NativeChild): string {
	const display = displays.get(child);
	if (!display) throw new Error("test_native_child_display_not_attached");
	const buffer = display.buffer.active;
	return Array.from({ length: display.rows }, (_, row) =>
		buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
	).join("\n");
}
