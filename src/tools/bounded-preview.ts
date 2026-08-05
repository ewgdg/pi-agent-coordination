const TOOL_PREVIEW_CODE_POINTS = 72;

export function boundedToolPreview(content: string): string {
	const normalized = content.replaceAll(/\s+/g, " ").trim();
	const codePoints = [...normalized];
	return codePoints.length <= TOOL_PREVIEW_CODE_POINTS
		? normalized
		: `${codePoints.slice(0, TOOL_PREVIEW_CODE_POINTS).join("")}…`;
}
