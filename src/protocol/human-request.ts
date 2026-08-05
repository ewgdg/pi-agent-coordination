import { isDeepStrictEqual } from "node:util";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	currentCoordinationScope,
	deriveHumanRequestIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";

export type HumanOption = Readonly<{
	label: string;
	description?: string;
}>;

export type SelectOneQuestion = Readonly<{
	kind: "select_one";
	header: string;
	prompt: string;
	options: readonly HumanOption[];
	allowOther: boolean;
}>;

export type SelectManyQuestion = Readonly<{
	kind: "select_many";
	header: string;
	prompt: string;
	options: readonly HumanOption[];
	allowOther: boolean;
}>;

export type TextQuestion = Readonly<{
	kind: "text";
	header: string;
	prompt: string;
	multiline: boolean;
}>;

export type HumanQuestion = SelectOneQuestion | SelectManyQuestion | TextQuestion;

export type HumanRequestInput = Readonly<{
	questions: readonly HumanQuestion[];
}>;

export type SelectOneAnswer = Readonly<
	| { kind: "select_one"; selectedOptionIndex: number }
	| { kind: "select_one"; customValue: string }
>;

export type SelectManyAnswer = Readonly<{
	kind: "select_many";
	selectedOptionIndexes: readonly number[];
	customValue?: string;
}>;

export type TextAnswer = Readonly<{
	kind: "text";
	text: string;
}>;

export type HumanQuestionAnswer = SelectOneAnswer | SelectManyAnswer | TextAnswer;

type HumanAnswerShape = Readonly<{
	requestId: string;
	answers: readonly HumanQuestionAnswer[];
}>;

export type HumanAnswerCandidate = HumanAnswerShape;
export type HumanAnswer = HumanAnswerShape;

export type HumanRequest = Readonly<{
	requestId: string;
	requesterAgentId: string;
	source: ToolCallPointer;
	questions: HumanRequestInput["questions"];
}>;

export type HumanRequestResultInspection =
	| Readonly<{ state: "pending" }>
	| Readonly<{
		state: "answered";
		answer: HumanAnswer;
		resultEntryId: string;
	}>
	| Readonly<{
		state: "interrupted";
		resultEntryId: string;
	}>;

export function resolveCommittedHumanRequest(options: {
	agentId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	providedInput: HumanRequestInput;
}): HumanRequest {
	const committed = resolveCommittedToolCall({
		agentId: options.agentId,
		sessionManager: options.sessionManager,
		toolCallId: options.toolCallId,
		toolName: "ask_user_question",
	});
	const input = validateHumanRequestInput(committed.input);
	const provided = validateHumanRequestInput(options.providedInput as unknown as Record<string, unknown>);
	if (!sameHumanRequestInput(input, provided)) {
		throw new Error("invariant_violation: Human Request input differs from its committed call");
	}
	return {
		requestId: deriveHumanRequestIdentity(committed.source),
		requesterAgentId: options.agentId,
		source: committed.source,
		questions: input.questions,
	};
}

export function validateHumanRequestInput(
	value: Record<string, unknown>,
): HumanRequestInput {
	if (!sameKeys(value, ["questions"]) || !Array.isArray(value.questions)) {
		throw new Error("invalid_input: Human Request input has an invalid shape");
	}
	if (value.questions.length === 0) {
		throw new Error("invalid_input: Human Request requires at least one Question");
	}
	const questions = value.questions.map((question, index) =>
		validateQuestion(question, index),
	);
	return {
		questions,
	};
}

export function validateHumanAnswers(
	questions: readonly HumanQuestion[],
	answers: readonly HumanQuestionAnswer[],
): readonly HumanQuestionAnswer[] {
	if (answers.length !== questions.length) {
		throw new Error("invalid_input: Human Answer must answer every Question exactly once");
	}
	return answers.map((answer, index) => validateAnswer(questions[index]!, answer, index));
}

export function inspectCommittedHumanRequestResult(options: {
	request: HumanRequest;
	sessionManager: SessionManager;
}): HumanRequestResultInspection {
	const matches = currentCoordinationScope(
		options.sessionManager,
		options.request.requesterAgentId,
	).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === options.request.source.toolCallId,
	);
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Human Request ${options.request.requestId} has multiple native results`,
		);
	}
	const match = matches[0];
	if (!match || match.type !== "message" || match.message.role !== "toolResult") {
		return { state: "pending" };
	}
	if (match.message.toolName !== "ask_user_question") {
		throw new ProtocolInvariantError(
			`Human Request ${options.request.requestId} result names ${match.message.toolName}`,
		);
	}
	if (match.message.isError) {
		return { state: "interrupted", resultEntryId: match.id };
	}
	const answer = validateHumanAnswer(
		options.request,
		match.message.details,
	);
	if (
		match.message.content.length !== 1 ||
		match.message.content[0]?.type !== "text"
	) {
		throw new ProtocolInvariantError(
			`Human Answer ${options.request.requestId} content has an invalid shape`,
		);
	}
	let content: unknown;
	try {
		content = JSON.parse(match.message.content[0].text);
	} catch {
		throw new ProtocolInvariantError(
			`Human Answer ${options.request.requestId} content is not valid JSON`,
		);
	}
	if (!isDeepStrictEqual(content, answer)) {
		throw new ProtocolInvariantError(
			`Human Answer ${options.request.requestId} content differs from its details`,
		);
	}
	return { state: "answered", answer, resultEntryId: match.id };
}

function validateHumanAnswer(
	request: HumanRequest,
	value: unknown,
): HumanAnswer {
	if (!isRecord(value) || !sameKeys(value, ["answers", "requestId"])) {
		throw new ProtocolInvariantError(
			`Human Answer ${request.requestId} has an invalid shape`,
		);
	}
	if (value.requestId !== request.requestId || !Array.isArray(value.answers)) {
		throw new ProtocolInvariantError(
			`Human Answer ${request.requestId} has invalid correlation`,
		);
	}
	let answers: readonly HumanQuestionAnswer[];
	try {
		answers = validateHumanAnswers(
			request.questions,
			value.answers as HumanQuestionAnswer[],
		);
	} catch (error) {
		throw new ProtocolInvariantError(
			`Human Answer ${request.requestId} is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { requestId: request.requestId, answers };
}

function validateQuestion(value: unknown, index: number): HumanQuestion {
	if (!isRecord(value)) {
		throw new Error(`invalid_input: Human Question ${index + 1} must be an object`);
	}
	if (value.kind === "text") {
		if (!sameKeys(value, ["header", "kind", "multiline", "prompt"])) {
			throw new Error(`invalid_input: text Question ${index + 1} has an invalid shape`);
		}
		return {
			kind: "text",
			header: requireNonBlank(value.header, `Question ${index + 1} header`),
			prompt: requireNonBlank(value.prompt, `Question ${index + 1} prompt`),
			multiline: requireBoolean(value.multiline, `Question ${index + 1} multiline`),
		};
	}
	if (value.kind !== "select_one" && value.kind !== "select_many") {
		throw new Error(`invalid_input: Human Question ${index + 1} kind is unavailable`);
	}
	if (!sameKeys(value, ["allowOther", "header", "kind", "options", "prompt"])) {
		throw new Error(`invalid_input: ${value.kind} Question ${index + 1} has an invalid shape`);
	}
	if (!Array.isArray(value.options) || value.options.length === 0) {
		throw new Error(`invalid_input: Question ${index + 1} requires at least one option`);
	}
	const options = value.options.map((option, optionIndex) =>
		validateOption(option, index, optionIndex),
	);
	const serializedOptions = options.map((option) => JSON.stringify(option));
	if (new Set(serializedOptions).size !== serializedOptions.length) {
		throw new Error(`invalid_input: Question ${index + 1} options must be unique`);
	}
	return {
		kind: value.kind,
		header: requireNonBlank(value.header, `Question ${index + 1} header`),
		prompt: requireNonBlank(value.prompt, `Question ${index + 1} prompt`),
		options,
		allowOther: requireBoolean(value.allowOther, `Question ${index + 1} allowOther`),
	};
}

function validateOption(value: unknown, questionIndex: number, optionIndex: number): HumanOption {
	if (!isRecord(value)) {
		throw new Error(
			`invalid_input: Question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
		);
	}
	const expectedKeys = value.description === undefined
		? ["label"]
		: ["description", "label"];
	if (!sameKeys(value, expectedKeys)) {
		throw new Error(
			`invalid_input: Question ${questionIndex + 1} option ${optionIndex + 1} has an invalid shape`,
		);
	}
	return {
		label: requireNonBlank(
			value.label,
			`Question ${questionIndex + 1} option ${optionIndex + 1} label`,
		),
		...(value.description === undefined
			? {}
			: {
				description: requireNonBlank(
					value.description,
					`Question ${questionIndex + 1} option ${optionIndex + 1} description`,
				),
			}),
	};
}

function validateAnswer(
	question: HumanQuestion,
	answer: HumanQuestionAnswer,
	index: number,
): HumanQuestionAnswer {
	if (!isRecord(answer) || answer.kind !== question.kind) {
		throw new Error(`invalid_input: Human Answer ${index + 1} does not match its Question`);
	}
	if (question.kind === "text") {
		if (answer.kind !== "text") {
			throw new Error(`invalid_input: Human Answer ${index + 1} does not match its Question`);
		}
		if (!sameKeys(answer, ["kind", "text"])) {
			throw new Error(`invalid_input: text Answer ${index + 1} has an invalid shape`);
		}
		return {
			kind: "text",
			text: requireNonBlank(answer.text, `Answer ${index + 1} text`),
		};
	}
	if (question.kind === "select_one") {
		if (answer.kind !== "select_one") {
			throw new Error(`invalid_input: Human Answer ${index + 1} does not match its Question`);
		}
		const hasIndex = "selectedOptionIndex" in answer;
		const hasCustom = "customValue" in answer;
		if (hasIndex === hasCustom) {
			throw new Error(
				`invalid_input: select-one Answer ${index + 1} requires exactly one choice`,
			);
		}
		if (hasIndex) {
			if (!sameKeys(answer, ["kind", "selectedOptionIndex"])) {
				throw new Error(`invalid_input: select-one Answer ${index + 1} has an invalid shape`);
			}
			return {
				kind: "select_one",
				selectedOptionIndex: requireOptionIndex(
					answer.selectedOptionIndex,
					question.options.length,
					index,
				),
			};
		}
		if (!sameKeys(answer, ["customValue", "kind"]) || !question.allowOther) {
			throw new Error(`invalid_input: select-one Answer ${index + 1} cannot use custom input`);
		}
		return {
			kind: "select_one",
			customValue: requireNonBlank(answer.customValue, `Answer ${index + 1} custom value`),
		};
	}
	if (answer.kind !== "select_many") {
		throw new Error(`invalid_input: Human Answer ${index + 1} does not match its Question`);
	}
	if (!Array.isArray(answer.selectedOptionIndexes)) {
		throw new Error(`invalid_input: select-many Answer ${index + 1} requires selected indexes`);
	}
	const expectedKeys = answer.customValue === undefined
		? ["kind", "selectedOptionIndexes"]
		: ["customValue", "kind", "selectedOptionIndexes"];
	if (!sameKeys(answer, expectedKeys)) {
		throw new Error(`invalid_input: select-many Answer ${index + 1} has an invalid shape`);
	}
	const selectedOptionIndexes = answer.selectedOptionIndexes.map((selected) =>
		requireOptionIndex(selected, question.options.length, index),
	);
	if (new Set(selectedOptionIndexes).size !== selectedOptionIndexes.length) {
		throw new Error(`invalid_input: select-many Answer ${index + 1} indexes must be unique`);
	}
	const customValue = answer.customValue === undefined
		? undefined
		: requireNonBlank(answer.customValue, `Answer ${index + 1} custom value`);
	if (customValue !== undefined && !question.allowOther) {
		throw new Error(`invalid_input: select-many Answer ${index + 1} cannot use custom input`);
	}
	if (selectedOptionIndexes.length === 0 && customValue === undefined) {
		throw new Error(`invalid_input: select-many Answer ${index + 1} requires a choice`);
	}
	return {
		kind: "select_many",
		selectedOptionIndexes,
		...(customValue === undefined ? {} : { customValue }),
	};
}

function requireOptionIndex(value: unknown, optionCount: number, answerIndex: number): number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= optionCount) {
		throw new Error(`invalid_input: Answer ${answerIndex + 1} option index is out of range`);
	}
	return value as number;
}

function requireNonBlank(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`invalid_input: ${name} must not be blank`);
	}
	return value;
}

function requireBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`invalid_input: ${name} must be boolean`);
	}
	return value;
}

function sameHumanRequestInput(left: HumanRequestInput, right: HumanRequestInput): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
