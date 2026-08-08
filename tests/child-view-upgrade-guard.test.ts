// Upgrade guard (#62): the child-view overlay borrows private InteractiveMode
// rendering methods against a shadow host. When Pi's dist adds a new
// `this.<member>` access inside those pinned method spans, the shadow host
// would break at runtime — this test turns that into a mechanical failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SHADOW_HOST_MEMBERS } from "../src/presentation/child-view-overlay.ts";

// Methods the shadow host runs against the host prototype. If Pi renames or
// removes one, the span lookup below fails loudly instead of silently passing.
const BORROWED_METHODS = [
	"handleEvent",
	"renderSessionEntries",
	"renderSessionItems",
	"addMessageToChat",
	"addCustomEntryToChat",
	"getUserMessageText",
	"getMarkdownThemeWithSettings",
	"getMarkdownTransformers",
	"getRegisteredToolDefinition",
	"addCacheMissNotice",
	"maybeShowCacheMissNotice",
	"rebuildChatFromMessages",
] as const;

function interactiveModeDistPath(): string {
	const entry = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	// <package>/dist/index.js -> <package>/dist/modes/interactive/interactive-mode.js
	const packageRoot = dirname(dirname(entry));
	return `${packageRoot}/dist/modes/interactive/interactive-mode.js`;
}

/** Class-level method span: from the method signature to its closing `}`. */
function methodSpan(source: string, name: string): string {
	const pattern = new RegExp(`\\n    (?:async )?${name}\\(`);
	const match = pattern.exec(source);
	if (!match) {
		throw new Error(
			`upgrade_guard: method ${name} not found in ${interactiveModeDistPath()}. ` +
				"Pi's InteractiveMode private rendering surface changed; re-pin the borrowed methods.",
		);
	}
	const bodyStart = source.indexOf("{", match.index);
	const bodyEnd = source.indexOf("\n    }", bodyStart);
	if (bodyEnd < 0) {
		throw new Error(
			`upgrade_guard: could not delimit method ${name}. Pi's dist formatting changed.`,
		);
	}
	return source.slice(match.index, bodyEnd);
}

function extractThisMembers(span: string): Set<string> {
	const members = new Set<string>();
	const regex = /this\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
	for (const match of span.matchAll(regex)) members.add(match[1]!);
	return members;
}

test("every this.<member> in the borrowed private-method spans is shadow-host-provided", () => {
	const source = readFileSync(interactiveModeDistPath(), "utf8");
	const missing = new Set<string>();
	for (const name of BORROWED_METHODS) {
		const span = methodSpan(source, name);
		for (const member of extractThisMembers(span)) {
			if (!SHADOW_HOST_MEMBERS.has(member)) missing.add(`${name}.${member}`);
		}
	}
	assert.deepEqual(
		[...missing],
		[],
		"Pi's dist accesses this.<member> that the child-view shadow host does not provide. " +
			"Extend SHADOW_HOST_MEMBERS and the shadow host in " +
			"src/presentation/child-view-overlay.ts, or re-pin the borrowed method.",
	);
});

test("the shadow host member set is not empty or stale", () => {
	assert.ok(
		SHADOW_HOST_MEMBERS.size >= 30,
		"SHADOW_HOST_MEMBERS looks truncated; the guard would not be meaningful",
	);
	for (const required of [
		"chatContainer",
		"renderSessionEntries",
		"handleEvent",
		"ui",
	]) {
		assert.ok(SHADOW_HOST_MEMBERS.has(required), `missing member ${required}`);
	}
});

test("guard path is stable: the dist file exists at the pinned location", () => {
	const path = interactiveModeDistPath();
	assert.doesNotThrow(() => readFileSync(path, "utf8"));
	assert.equal(pathToFileURL(path).protocol, "file:");
});
