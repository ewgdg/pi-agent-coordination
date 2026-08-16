import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

const COLLAPSED_BODY_LINES = 2;

/**
 * Shared collapsed body preview for coordination content.
 *
 * One bounded preview for delivered Message bodies, sent Message/Request
 * payloads, Answers, cancellation reasons, and retrieved Answer previews:
 * whitespace is normalized, the body wraps to the supplied width, and a
 * trailing ellipsis marks truncation. Long bodies are capped at
 * {@link COLLAPSED_BODY_LINES} visible lines.
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
		const normalized = this.#body.replaceAll(/\s+/g, " ").trim();
		if (normalized.length === 0) return [];
		const lines = wrapTextWithAnsi(this.#color(normalized), width);
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
