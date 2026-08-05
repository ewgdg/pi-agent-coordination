import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	validateHumanAnswers,
	type HumanQuestion,
	type HumanQuestionAnswer,
	type HumanRequest,
} from "../protocol/human-request.ts";
import type {
	HumanAttentionItem,
	HumanRequestPresentation,
	PresentedHumanRequest,
} from "../coordination/human-requests.ts";

const ATTENTION_STATUS_KEY = "agent-coordination-attention";
const ATTENTION_WIDGET_KEY = "agent-coordination-attention";
const REQUEST_OVERLAY_WIDTH = "80%";
const REQUEST_OVERLAY_MAX_HEIGHT = "80%";
// Keep short multi-Question tabs and their controls legible on compact terminals.
const REQUEST_OVERLAY_MIN_WIDTH = 48;

type SurfaceOutcome =
	| Readonly<{ kind: "submit"; answers: readonly HumanQuestionAnswer[] }>
	| Readonly<{ kind: "interrupt" }>
	| Readonly<{ kind: "background" | "dismissed" }>;

type FocusedSurface = {
	requestId: string;
	finish(outcome: SurfaceOutcome): void;
	settled: Promise<void>;
};

export class HumanRequestSurface implements HumanRequestPresentation {
	readonly #requests = new Map<string, PresentedHumanRequest>();
	readonly #ui: ExtensionUIContext;
	#focused: FocusedSurface | undefined;
	#focusChain = Promise.resolve();

	constructor(ui: ExtensionUIContext) {
		this.#ui = ui;
	}

	present(
		presentation: PresentedHumanRequest,
		foreground: boolean,
	): void {
		if (this.#requests.has(presentation.requestId)) {
			throw new Error(`invariant_violation: Human Request ${presentation.requestId} is already open`);
		}
		this.#requests.set(presentation.requestId, presentation);
		this.#renderPassiveAttention();
		if (foreground) void this.focus(presentation.requestId);
	}

	dismiss(requestId: string): void {
		this.#requests.delete(requestId);
		if (this.#focused?.requestId === requestId) {
			this.#focused.finish({ kind: "dismissed" });
		}
		this.#renderPassiveAttention();
	}

	items(): readonly HumanAttentionItem[] {
		return [...this.#requests.values()].map(
			({ requestId, agentId, agentLabel, questionCount }) => ({
				requestId,
				agentId,
				agentLabel,
				questionCount,
			}),
		);
	}

	focus(requestId: string): Promise<void> {
		const operation = this.#focusChain.then(() => this.#focus(requestId));
		this.#focusChain = operation.catch(() => undefined);
		return operation;
	}

	async #focus(requestId: string): Promise<void> {
		const presentation = this.#requests.get(requestId);
		if (!presentation) throw new Error(`unknown_identity: Human Request ${requestId}`);
		if (this.#focused?.requestId === requestId) return;
		if (this.#focused) {
			const previous = this.#focused;
			previous.finish({ kind: "background" });
			await previous.settled;
		}
		const ui = this.#ui;
		let finish: (outcome: SurfaceOutcome) => void = () => undefined;
		let settleFocused!: () => void;
		const settled = new Promise<void>((resolve) => {
			settleFocused = resolve;
		});
		const focused: FocusedSurface = {
			requestId,
			finish: (outcome) => finish(outcome),
			settled,
		};
		this.#focused = focused;
		try {
			const outcome = await ui.custom<SurfaceOutcome>(
				(tui, theme, _keybindings, done) => {
					let finished = false;
					finish = (result) => {
						if (finished) return;
						finished = true;
						done(result);
					};
					return createHumanRequestComponent({
						tui,
						theme,
						request: presentation.request,
						finish,
					});
				},
				{
					overlay: true,
					overlayOptions: {
						width: REQUEST_OVERLAY_WIDTH,
						minWidth: REQUEST_OVERLAY_MIN_WIDTH,
						maxHeight: REQUEST_OVERLAY_MAX_HEIGHT,
						anchor: "center",
					},
				},
			);
			if (outcome.kind === "submit") {
				presentation.submit(outcome.answers);
			} else if (outcome.kind === "interrupt") {
				presentation.interrupt();
			}
		} catch (error) {
			ui.notify(
				`Human Request surface failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			if (this.#focused === focused) this.#focused = undefined;
			settleFocused();
		}
	}

	#renderPassiveAttention(): void {
		const ui = this.#ui;
		const requests = [...this.#requests.values()];
		if (requests.length === 0) {
			ui.setStatus(ATTENTION_STATUS_KEY, undefined);
			ui.setWidget(ATTENTION_WIDGET_KEY, undefined);
			return;
		}
		ui.setStatus(
			ATTENTION_STATUS_KEY,
			`${requests.length} Human Request${requests.length === 1 ? "" : "s"} · DECIDE`,
		);
		ui.setWidget(
			ATTENTION_WIDGET_KEY,
			[
				`Attention · ${requests.length} DECIDE`,
				...requests.map(
					(request) =>
						`  ${request.agentLabel} · ${request.questionCount} Question${request.questionCount === 1 ? "" : "s"}`,
				),
			],
			{ placement: "aboveEditor" },
		);
	}
}

export function createHumanRequestComponent(options: {
	tui: Pick<TUI, "requestRender">;
	theme: Theme;
	request: HumanRequest;
	finish(outcome: SurfaceOutcome): void;
}): Component {
	const { tui, theme, request, finish } = options;
	const questions = request.questions;
	const answers = new Map<number, HumanQuestionAnswer>();
	const cursors = questions.map(() => 0);
	const selectedMany = questions.map(() => new Set<number>());
	const textDrafts = questions.map(() => "");
	const customDrafts = questions.map(() => "");
	let currentIndex = 0;
	let editingCustom = false;
	let cachedLines: string[] | undefined;
	let finished = false;

	function refresh(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	function complete(outcome: SurfaceOutcome): void {
		if (finished) return;
		finished = true;
		finish(outcome);
	}

	function advance(): void {
		editingCustom = false;
		if (currentIndex < questions.length - 1) {
			currentIndex += 1;
		} else if (submitIfComplete()) {
			return;
		}
		refresh();
	}

	function submitIfComplete(): boolean {
		if (answers.size !== questions.length) return false;
		const positional = questions.map((_question, index) => answers.get(index)!);
		complete({
			kind: "submit",
			answers: validateHumanAnswers(questions, positional),
		});
		return true;
	}

	function answerCurrentQuestion(question: HumanQuestion): void {
		if (question.kind === "select_one") {
			const cursor = cursors[currentIndex]!;
			if (cursor === question.options.length && question.allowOther) {
				editingCustom = true;
				refresh();
				return;
			}
			if (cursor >= question.options.length) return;
			answers.set(currentIndex, {
				kind: "select_one",
				selectedOptionIndex: cursor,
			});
			advance();
			return;
		}
		if (question.kind === "select_many") {
			const cursor = cursors[currentIndex]!;
			if (cursor === question.options.length && question.allowOther) {
				editingCustom = true;
				refresh();
				return;
			}
			const indexes = [...selectedMany[currentIndex]!].sort((left, right) => left - right);
			const customValue = customDrafts[currentIndex]!.trim().length === 0
				? undefined
				: customDrafts[currentIndex]!;
			if (indexes.length === 0 && customValue === undefined) return;
			answers.set(currentIndex, {
				kind: "select_many",
				selectedOptionIndexes: indexes,
				...(customValue === undefined ? {} : { customValue }),
			});
			advance();
			return;
		}
		const text = textDrafts[currentIndex]!;
		if (text.trim().length === 0) return;
		answers.set(currentIndex, { kind: "text", text });
		advance();
	}

	function answerCustom(question: HumanQuestion): void {
		if (question.kind === "text") return;
		const customValue = customDrafts[currentIndex]!;
		if (customValue.trim().length === 0) return;
		if (question.kind === "select_one") {
			answers.set(currentIndex, { kind: "select_one", customValue });
		} else {
			answers.set(currentIndex, {
				kind: "select_many",
				selectedOptionIndexes: [...selectedMany[currentIndex]!].sort(
					(left, right) => left - right,
				),
				customValue,
			});
		}
		advance();
	}

	function handleInput(data: string): void {
		if (finished) return;
		if (matchesKey(data, Key.escape)) {
			complete({ kind: "interrupt" });
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			editingCustom = false;
			currentIndex = (currentIndex + 1) % questions.length;
			refresh();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			editingCustom = false;
			currentIndex = (currentIndex - 1 + questions.length) % questions.length;
			refresh();
			return;
		}
		const question = questions[currentIndex]!;
		if (editingCustom && question.kind !== "text") {
			if (matchesKey(data, Key.enter)) {
				answerCustom(question);
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				customDrafts[currentIndex] = Array.from(customDrafts[currentIndex]!)
					.slice(0, -1)
					.join("");
				answers.delete(currentIndex);
				refresh();
				return;
			}
			if (isPrintableInput(data)) {
				customDrafts[currentIndex] += data;
				answers.delete(currentIndex);
				refresh();
			}
			return;
		}
		if (question.kind === "text") {
			if (matchesKey(data, Key.enter)) {
				answerCurrentQuestion(question);
				return;
			}
			if (question.multiline && matchesKey(data, Key.shift("enter"))) {
				textDrafts[currentIndex] += "\n";
				answers.delete(currentIndex);
				refresh();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				textDrafts[currentIndex] = Array.from(textDrafts[currentIndex]!).slice(0, -1).join("");
				answers.delete(currentIndex);
				refresh();
				return;
			}
			if (isPrintableInput(data)) {
				textDrafts[currentIndex] += data;
				answers.delete(currentIndex);
				refresh();
			}
			return;
		}
		if (matchesKey(data, Key.up)) {
			cursors[currentIndex] = Math.max(0, cursors[currentIndex]! - 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			cursors[currentIndex] = Math.min(
				question.options.length - (question.allowOther ? 0 : 1),
				cursors[currentIndex]! + 1,
			);
			refresh();
			return;
		}
		if (question.kind === "select_many" && matchesKey(data, Key.space)) {
			if (
				question.allowOther &&
				cursors[currentIndex] === question.options.length
			) {
				editingCustom = true;
				refresh();
				return;
			}
			const selections = selectedMany[currentIndex]!;
			const cursor = cursors[currentIndex]!;
			if (selections.has(cursor)) selections.delete(cursor);
			else selections.add(cursor);
			answers.delete(currentIndex);
			refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			answerCurrentQuestion(question);
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;
		const renderWidth = Math.max(1, width);
		const question = questions[currentIndex]!;
		const lines: string[] = [theme.fg("accent", "─".repeat(renderWidth))];
		const tabs = questions.map((candidate, index) => {
			const marker = answers.has(index) ? "■" : "□";
			const label = ` ${marker} ${candidate.header} `;
			return index === currentIndex
				? theme.bg("selectedBg", theme.fg("text", label))
				: theme.fg(answers.has(index) ? "success" : "muted", label);
		});
		addWrapped(lines, ` ${tabs.join(" ")}`, renderWidth);
		lines.push("");
		addWrapped(lines, ` ${theme.fg("text", question.prompt)}`, renderWidth);
		lines.push("");
		if (question.kind === "text") {
			const draft = textDrafts[currentIndex]!;
			addWrapped(
				lines,
				` ${theme.fg(draft.length === 0 ? "muted" : "text", draft.length === 0 ? "Type your answer…" : draft)}`,
				renderWidth,
			);
		} else {
			for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
				const option = question.options[optionIndex]!;
				const cursor = cursors[currentIndex] === optionIndex;
				const selected = question.kind === "select_many" &&
					selectedMany[currentIndex]!.has(optionIndex);
				const prefix = cursor ? "> " : "  ";
				const marker = question.kind === "select_many"
					? selected ? "[x] " : "[ ] "
					: "";
				addWrappedWithPrefix(
					lines,
					prefix,
					theme.fg(cursor ? "accent" : "text", `${marker}${optionIndex + 1}. ${option.label}`),
					renderWidth,
				);
				if (option.description) {
					addWrappedWithPrefix(
						lines,
						"     ",
						theme.fg("muted", option.description),
						renderWidth,
					);
				}
			}
			if (question.allowOther) {
				const cursor = cursors[currentIndex] === question.options.length;
				const draft = customDrafts[currentIndex]!;
				const marker = question.kind === "select_many"
					? draft.trim().length === 0 ? "[ ] " : "[x] "
					: "";
				addWrappedWithPrefix(
					lines,
					cursor ? "> " : "  ",
					theme.fg(
						cursor || editingCustom ? "accent" : "text",
						`${marker}Other${editingCustom || draft.length > 0 ? `: ${draft || "Type a custom answer…"}` : ""}`,
					),
					renderWidth,
				);
			}
		}
		lines.push("");
		addWrapped(
			lines,
			` ${theme.fg("dim", `Tab/←→ Questions · ↑↓ choose · Enter confirm · Esc interrupt`)}`,
			renderWidth,
		);
		lines.push(theme.fg("accent", "─".repeat(renderWidth)));
		cachedLines = lines;
		return lines;
	}

	return {
		render,
		handleInput,
		invalidate() {
			cachedLines = undefined;
		},
	};
}

function addWrapped(lines: string[], value: string, width: number): void {
	lines.push(...wrapTextWithAnsi(value, width));
}

function addWrappedWithPrefix(
	lines: string[],
	prefix: string,
	value: string,
	width: number,
): void {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		addWrapped(lines, `${prefix}${value}`, width);
		return;
	}
	const wrapped = wrapTextWithAnsi(value, width - prefixWidth);
	for (let index = 0; index < wrapped.length; index += 1) {
		lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
	}
}

function isPrintableInput(data: string): boolean {
	return data.length > 0 && Array.from(data).every((character) => character >= " ");
}
