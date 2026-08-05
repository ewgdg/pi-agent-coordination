const MAX_AGENT_DESCRIPTION_CODE_POINTS = 240;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cs}]/u;

export function normalizeAgentDescription(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new Error("invalid_input: Agent description must not be empty");
	}
	if (CONTROL_CHARACTER.test(normalized)) {
		throw new Error("invalid_input: Agent description must not contain control characters");
	}
	if ([...normalized].length > MAX_AGENT_DESCRIPTION_CODE_POINTS) {
		throw new Error(
			`invalid_input: Agent description exceeds ${MAX_AGENT_DESCRIPTION_CODE_POINTS} Unicode code points`,
		);
	}
	return normalized;
}
