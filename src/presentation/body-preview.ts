import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

// Match Pi's built-in read preview so coordination messages expose a useful
// amount of context without requiring expansion.
const COLLAPSED_BODY_LINES = 10;

/**
 * Shared collapsed body preview for coordination content.
 *
 * One bounded preview for delivered Message bodies, sent Message/Request
 * payloads, Answers, cancellation reasons, and retrieved Answer previews:
 * source formatting is preserved, the body wraps to the supplied width, and a
 * trailing ellipsis marks truncation. Long bodies are capped at
 * {@link COLLAPSED_BODY_LINES} visible terminal rows.
 */
export class BodyPreview implements Component {
	readonly #body: string;
	readonly #color: (content: string) => string;

	constructor(body: string, color: (content: string) => string) {
		this.#body = body;
		this.#color = color;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const formatted = formattedBody(this.#body);
		if (formatted.length === 0) return [];
		const lines = wrapTextWithAnsi(this.#color(formatted), width);
		if (lines.length <= COLLAPSED_BODY_LINES) return lines;

		const visibleLines = lines.slice(0, COLLAPSED_BODY_LINES);
		const ellipsis = this.#color("…");
		const bodyWidth = Math.max(0, width - visibleWidth(ellipsis));
		visibleLines[COLLAPSED_BODY_LINES - 1] =
			truncateToWidth(
				visibleLines[COLLAPSED_BODY_LINES - 1]!,
				bodyWidth,
				"",
			) + ellipsis;
		return visibleLines;
	}

	invalidate(): void {}
}

function formattedBody(body: string): string {
	const lines = body.replaceAll(/\r\n?/g, "\n").split("\n");
	const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
	if (firstContentLine === -1) return "";
	const lastContentLine = lines.findLastIndex((line) => line.trim().length > 0);
	return lines.slice(firstContentLine, lastContentLine + 1).join("\n");
}
