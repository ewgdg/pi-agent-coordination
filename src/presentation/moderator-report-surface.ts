import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatModeratorReport, type ReportHistoryItem } from "../protocol/moderator-report.ts";

const FIXED_PRESENTATION_ROWS = 3;
const PAGE_OVERLAP_ROWS = 1;

export type ModeratorReportSurfaceResult = "back" | "view_reporter";
export type ModeratorReportSurfaceOptions = Readonly<{
	markRead(): Promise<void> | void;
	copyReport(text: string): Promise<void> | void;
}>;

export function openModeratorReportSurface(
	ui: ExtensionUIContext,
	item: ReportHistoryItem,
	options: ModeratorReportSurfaceOptions,
): Promise<ModeratorReportSurfaceResult> {
	return ui.custom<ModeratorReportSurfaceResult>(
		(tui, theme, _keybindings, done) => new ModeratorReportSurface(tui, theme, item, options, done),
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
	);
}

class ModeratorReportSurface implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #options: ModeratorReportSurfaceOptions;
	readonly #done: (result: ModeratorReportSurfaceResult) => void;
	readonly #reportText: string;
	readonly #body: Text;
	#read: boolean;
	#pending = false;
	#closed = false;
	#feedback = "";
	#scrollTop = 0;
	#maximumScrollTop = 0;
	#viewportRows = 1;

	constructor(tui: TUI, theme: Theme, item: ReportHistoryItem,
		options: ModeratorReportSurfaceOptions, done: (result: ModeratorReportSurfaceResult) => void) {
		this.#tui = tui;
		this.#theme = theme;
		this.#options = options;
		this.#done = done;
		this.#read = item.readAt !== undefined;
		this.#reportText = formatModeratorReport(item.report);
		// Plain wrapped Markdown keeps every source reference visible, including link destinations.
		this.#body = new Text(sanitizeReportTerminalText(this.#reportText), 0, 0);
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(1, Math.floor(width));
		const height = Math.max(1, Math.floor(this.#tui.terminal.rows));
		const body = this.#body.render(boundedWidth);
		this.#viewportRows = Math.max(1, height - FIXED_PRESENTATION_ROWS);
		this.#maximumScrollTop = Math.max(0, body.length - this.#viewportRows);
		this.#scrollTop = Math.min(this.#scrollTop, this.#maximumScrollTop);
		const lines = [
			this.#theme.fg("accent", this.#theme.bold(`Moderator report · read-only · ${this.#read ? "Read" : "Unread"}`)),
			...body.slice(this.#scrollTop, this.#scrollTop + this.#viewportRows),
			this.#theme.fg("muted", this.#pending ? "Working…" : this.#feedback),
			this.#theme.fg("dim", "m Mark read · c Copy report · v View reporter · ↑/↓ scroll · PgUp/PgDn · Home/End · Esc/q back"),
		];
		return lines.slice(0, height).map((line) => truncateToWidth(line, boundedWidth, ""));
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.#close("back");
			return;
		}
		if (matchesKey(data, "v")) {
			this.#close("view_reporter");
			return;
		}
		if (matchesKey(data, "m")) {
			if (!this.#read && !this.#pending) void this.#perform(async () => {
				await this.#options.markRead();
				this.#read = true;
				this.#feedback = "Marked read";
			});
			return;
		}
		if (matchesKey(data, "c")) {
			if (!this.#pending) void this.#perform(async () => {
				await this.#options.copyReport(this.#reportText);
				this.#feedback = "Copied report";
			});
			return;
		}
		const pageRows = Math.max(1, this.#viewportRows - PAGE_OVERLAP_ROWS);
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#scrollTop--;
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#scrollTop++;
		else if (matchesKey(data, Key.pageUp)) this.#scrollTop -= pageRows;
		else if (matchesKey(data, Key.pageDown)) this.#scrollTop += pageRows;
		else if (matchesKey(data, Key.home)) this.#scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.#scrollTop = this.#maximumScrollTop;
		else return;
		this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, this.#maximumScrollTop));
		this.#tui.requestRender();
	}

	invalidate(): void { this.#body.invalidate(); }

	dispose(): void { this.#closed = true; }

	#close(result: ModeratorReportSurfaceResult): void {
		this.#closed = true;
		this.#done(result);
	}

	async #perform(operation: () => Promise<void>): Promise<void> {
		this.#pending = true;
		this.#feedback = "";
		this.#tui.requestRender();
		try {
			await operation();
		} catch (error) {
			// A failed persistence/clipboard action must stay visible and never imply acknowledgement.
			this.#feedback = sanitizeReportTerminalText(error instanceof Error ? error.message : String(error))
				.replace(/\s+/g, " ");
		} finally {
			this.#pending = false;
			if (!this.#closed) this.#tui.requestRender();
		}
	}
}

/** Report text is evidence, not a channel for terminal commands. */
export function sanitizeReportTerminalText(value: string): string {
	return value
		.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|\^[^\x1b]*(?:\x1b\\)|X[^\x1b]*(?:\x1b\\))/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
