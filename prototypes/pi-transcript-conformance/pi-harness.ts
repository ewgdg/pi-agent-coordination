import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type Context,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { check, type ConformanceReport, type HookSnapshot } from "./conformance-model.ts";

const PINNED_PI_VERSION = "0.82.0";
const BRANCH_MARKER_TYPE = "wayfinder-branch-marker-prototype";
const DELIVERY_TYPE = "wayfinder-delivery-prototype";
const DELIVERY_CONTENT = "prototype delivery content";
const DELIVERY_DETAILS_SENTINEL = "details-must-not-reach-model";
const IDLE_DELIVERY_TYPE = "wayfinder-idle-delivery-prototype";
const IDLE_DELIVERY_CONTENT = "prototype idle delivery content";
const COMPACTION_RESERVE_TOKENS = 64;
const COMPACTION_KEEP_RECENT_TOKENS = 24;
const EXPECTED_PROVIDER_TURNS = 2;

interface DeferredSignal {
	promise: Promise<void>;
	release(): void;
}

interface MutableHarnessState {
	session?: AgentSession;
	deliveryQueued: boolean;
	snapshots: HookSnapshot[];
	toolExecutionStarts: string[];
	toolCompletionOrder: string[];
	slowToolRelease: DeferredSignal;
	compactionObserved?: {
		leafIsCompaction: boolean;
		agentContextWasRebuilt: boolean;
	};
	branchMarker?: {
		markerId: string;
		parentId: string | null;
		selectedLeafId: string | null;
		oldLeafId: string | null;
		preMarkerReopenedLeafId: string | null;
	};
}

export async function runPiTranscriptConformance(): Promise<ConformanceReport> {
	const scratchRoot = mkdtempSync(join(tmpdir(), "pi-transcript-conformance-prototype-"));
	const scratchAgentDirectory = join(scratchRoot, "agent-config");
	const scratchSessionDirectory = join(scratchRoot, "sessions");
	const snapshots: HookSnapshot[] = [];
	const mutableState: MutableHarnessState = {
		deliveryQueued: false,
		snapshots,
		toolExecutionStarts: [],
		toolCompletionOrder: [],
		slowToolRelease: createDeferredSignal(),
	};

	try {
		const settingsManager = SettingsManager.inMemory({
			compaction: {
				enabled: true,
				reserveTokens: COMPACTION_RESERVE_TOKENS,
				keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
			},
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		});
		const sessionManager = SessionManager.create(scratchRoot, scratchSessionDirectory);
		const modelHarness = await createFauxModelHarness();
		const extension = createConformanceExtension(mutableState);
		const resourceLoader = new DefaultResourceLoader({
			cwd: scratchRoot,
			agentDir: scratchAgentDirectory,
			settingsManager,
			extensionFactories: [{ name: "pi-transcript-conformance", factory: extension, hidden: true }],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: scratchRoot,
			agentDir: scratchAgentDirectory,
			model: modelHarness.model,
			modelRuntime: modelHarness.modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
			noTools: "builtin",
		});
		mutableState.session = session;

		await session.prompt("run the transcript conformance turn");
		await session.waitForIdle();

		const sessionFile = requireSessionFile(sessionManager);
		await session.sendCustomMessage({
			customType: IDLE_DELIVERY_TYPE,
			content: IDLE_DELIVERY_CONTENT,
			display: false,
			details: { source: "idle-sdk-send" },
		});
		const idleDeliveryReopen = SessionManager.open(sessionFile, scratchSessionDirectory, scratchRoot);
		const idleDeliveryLeaf = idleDeliveryReopen.getLeafEntry();
		const entriesAfterAgentRun = sessionManager.getBranch();
		const firstAssistantWithTools = entriesAfterAgentRun.find(
			(entry) => entry.type === "message" && entry.message.role === "assistant" && assistantToolCallIds(entry.message).length > 0,
		);
		if (!firstAssistantWithTools) {
			throw new Error("Fake provider did not create the expected assistant tool-call entry");
		}

		await session.compact();
		const compactionLeaf = sessionManager.getLeafEntry();
		if (compactionLeaf?.type !== "compaction") {
			throw new Error("Manual compaction did not leave a compaction entry at the active leaf");
		}
		const compactionEntryId = compactionLeaf.id;

		const selectedLeafId = firstAssistantWithTools.id;
		await session.navigateTree(selectedLeafId, { summarize: false });
		const branchAfterNavigation = sessionManager.getBranch();
		const marker = mutableState.branchMarker;
		if (!marker) {
			throw new Error("session_tree did not append the branch marker");
		}
		const reopenedSession = SessionManager.open(sessionFile, scratchSessionDirectory, scratchRoot);
		const reopenedLeaf = reopenedSession.getLeafEntry();

		const providerContexts = modelHarness.contexts;
		const toolCallSnapshots = snapshots.filter((snapshot) => snapshot.hook === "tool_call");
		const toolResultSnapshots = snapshots.filter((snapshot) => snapshot.hook === "tool_result");
		const executionEndSnapshots = snapshots.filter((snapshot) => snapshot.hook === "tool_execution_end");
		const resultMessageEndSnapshots = snapshots.filter(
			(snapshot) => snapshot.hook === "message_end" && snapshot.eventSubject?.startsWith("toolResult:") === true,
		);
		const firstTurnEnd = snapshots.find(
			(snapshot) => snapshot.hook === "turn_end" && resultIds(snapshot.branch).length === 2,
		);
		const assistantMessageEnd = snapshots.find(
			(snapshot) => snapshot.hook === "message_end" && snapshot.eventSubject === "assistant:slow-tool,fast-tool",
		);
		const enqueueSnapshot = snapshots.find((snapshot) => snapshot.hook === "custom_message_enqueued");
		const settledSnapshot = snapshots.at(-1)?.hook === "agent_settled" ? snapshots.at(-1) : snapshots.findLast((snapshot) => snapshot.hook === "agent_settled");
		const deliveredModelContext = providerContexts[1];

		const checks = [
			check(
				"message_end is pre-append",
				assistantMessageEnd !== undefined &&
					!assistantMessageEnd.branch.includes("message:assistant:slow-tool,fast-tool") &&
					!assistantMessageEnd.file.includes("message:assistant:slow-tool,fast-tool"),
				assistantMessageEnd ? `branch: ${assistantMessageEnd.branch.join(" → ")}` : "assistant message_end snapshot missing",
			),
			check(
				"tool_call sees assistant commit",
				toolCallSnapshots.length === 2 &&
					toolCallSnapshots.every(
						(snapshot) =>
							snapshot.branch.includes("message:assistant:slow-tool,fast-tool") &&
							snapshot.file.includes("message:assistant:slow-tool,fast-tool") &&
							snapshot.toolExecutionStarts.length === 0,
					),
				`${toolCallSnapshots.length} tool_call snapshots captured after assistant JSONL append and before execution`,
			),
			check(
				"tool result hooks precede result append",
				toolResultSnapshots.length === 2 &&
					executionEndSnapshots.length === 2 &&
					[...toolResultSnapshots, ...executionEndSnapshots].every((snapshot) => {
						const toolCallId = snapshot.eventSubject;
						return (
							toolCallId !== undefined &&
							!snapshot.branch.includes(`message:toolResult:${toolCallId}`) &&
							!snapshot.file.includes(`message:toolResult:${toolCallId}`)
						);
					}),
				`tool completion order: ${mutableState.toolCompletionOrder.join(" → ")}`,
			),
			check(
				"tool-result message_end is pre-append",
				resultMessageEndSnapshots.length === 2 &&
					resultMessageEndSnapshots.every((snapshot) => {
						const toolCallId = snapshot.eventSubject?.slice("toolResult:".length);
						return (
							toolCallId !== undefined &&
							!snapshot.branch.includes(`message:toolResult:${toolCallId}`) &&
							!snapshot.file.includes(`message:toolResult:${toolCallId}`)
						);
					}),
				`${resultMessageEndSnapshots.length} result message_end snapshots captured before their own append`,
			),
			check(
				"turn_end sees source-ordered result batch",
				firstTurnEnd !== undefined &&
					resultIds(firstTurnEnd.branch).join(",") === "slow-tool,fast-tool" &&
					resultIds(firstTurnEnd.file).join(",") === "slow-tool,fast-tool",
				firstTurnEnd ? `persisted results: ${resultIds(firstTurnEnd.branch).join(" → ")}` : "result-bearing turn_end snapshot missing",
			),
			check(
				"custom delivery commits after enqueue",
				enqueueSnapshot !== undefined &&
					!enqueueSnapshot.branch.includes(`custom_message:${DELIVERY_TYPE}`) &&
					!enqueueSnapshot.file.includes(`custom_message:${DELIVERY_TYPE}`) &&
					entriesAfterAgentRun.some((entry) => entry.type === "custom_message" && entry.customType === DELIVERY_TYPE) &&
					deliveredModelContext !== undefined &&
					modelContextContainsDelivery(deliveredModelContext),
				"streaming steer was memory-only at enqueue and committed before the immediately next model context",
			),
			check(
				"custom content, not details, reaches model",
				deliveredModelContext !== undefined && !JSON.stringify(deliveredModelContext).includes(DELIVERY_DETAILS_SENTINEL),
				deliveredModelContext ? "fake provider received delivery content without local correlation details" : "delivery content did not reach fake provider",
			),
			check(
				"idle custom delivery survives reopen",
				idleDeliveryLeaf?.type === "custom_message" && idleDeliveryLeaf.customType === IDLE_DELIVERY_TYPE,
				"awaited idle SDK send was the leaf selected by a fresh SessionManager.open()",
			),
			check(
				"agent_settled follows queued continuation",
				settledSnapshot !== undefined && settledSnapshot.branch.includes(`custom_message:${DELIVERY_TYPE}`) && modelHarness.getCallCount() === EXPECTED_PROVIDER_TURNS,
				`${providerContexts.length} provider turns completed before settlement`,
			),
			check(
				"session_compact is post-append and post-rebuild",
				mutableState.compactionObserved?.leafIsCompaction === true && mutableState.compactionObserved.agentContextWasRebuilt === true,
				"compaction hook observed compaction leaf and compactionSummary agent context",
			),
			check(
				"compaction remains branch-scoped",
				sessionManager.getEntries().some((entry) => entry.id === compactionEntryId) &&
					!branchAfterNavigation.some((entry) => entry.id === compactionEntryId) &&
					!session.messages.some((message) => message.role === "compactionSummary"),
				"full entries retain the old-branch compaction while the selected sibling branch rebuild excludes it",
			),
			check(
				"session_tree marker survives restart",
				marker.preMarkerReopenedLeafId === marker.oldLeafId &&
					marker.preMarkerReopenedLeafId !== selectedLeafId &&
					reopenedLeaf?.type === "custom" &&
					reopenedLeaf.id === marker.markerId &&
					reopenedLeaf.parentId === selectedLeafId &&
					marker.selectedLeafId === selectedLeafId,
				`before marker, reopen selected old tail ${marker.preMarkerReopenedLeafId}; after marker, reopen selected ${reopenedLeaf?.id ?? "missing"} parented to ${selectedLeafId}`,
			),
		];

		return {
			piVersion: PINNED_PI_VERSION,
			checks,
			snapshots,
			coreChangeVerdict:
				"SDK host + extension needs no Pi-core change for these commit boundaries. A strict extension-only immediate acknowledgement for model-visible delivery still lacks a generic post-append event or returned entry ID; adding that notification would require Pi-core, while later branch observation or SDK inspection works today.",
			scratchSessionFile: sessionFile,
		};
	} catch (error) {
		return {
			piVersion: PINNED_PI_VERSION,
			checks: [],
			snapshots,
			coreChangeVerdict: "The seam verdict could not be evaluated because the prototype failed before completing.",
			runtimeError: error instanceof Error ? error.stack ?? error.message : String(error),
		};
	}
}

function createConformanceExtension(mutableState: MutableHarnessState): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "slow_probe",
			label: "Slow conformance probe",
			description: "Returns a deterministic slow result for transcript ordering checks.",
			parameters: Type.Object({}),
			async execute() {
				mutableState.toolExecutionStarts.push("slow-tool");
				await mutableState.slowToolRelease.promise;
				mutableState.toolCompletionOrder.push("slow-tool");
				return { content: [{ type: "text", text: "slow result" }], details: { result: "slow" } };
			},
		});

		pi.registerTool({
			name: "fast_probe",
			label: "Fast conformance probe",
			description: "Returns a deterministic fast result for transcript ordering checks.",
			parameters: Type.Object({}),
			async execute() {
				mutableState.toolExecutionStarts.push("fast-tool");
				mutableState.toolCompletionOrder.push("fast-tool");
				mutableState.slowToolRelease.release();
				return { content: [{ type: "text", text: "fast result" }], details: { result: "fast" } };
			},
		});

		pi.on("message_end", (event, context) => {
			const toolCallIds = event.message.role === "assistant" ? assistantToolCallIds(event.message) : [];
			const eventSubject =
				event.message.role === "assistant"
					? `assistant:${toolCallIds.join(",") || "text"}`
					: event.message.role === "toolResult"
						? `toolResult:${event.message.toolCallId}`
						: event.message.role;
			recordSnapshot(
				mutableState,
				"message_end",
				context,
				eventSubject,
			);
		});

		pi.on("tool_call", (event, context) => {
			recordSnapshot(mutableState, "tool_call", context, event.toolCallId);
			if (!mutableState.deliveryQueued) {
				mutableState.deliveryQueued = true;
				pi.sendMessage(
					{
						customType: DELIVERY_TYPE,
						content: DELIVERY_CONTENT,
						display: false,
						details: { sentinel: DELIVERY_DETAILS_SENTINEL },
					},
					{ deliverAs: "steer" },
				);
				recordSnapshot(mutableState, "custom_message_enqueued", context, DELIVERY_TYPE);
			}
		});

		pi.on("tool_result", (event, context) => {
			recordSnapshot(mutableState, "tool_result", context, event.toolCallId);
		});

		pi.on("tool_execution_end", (event, context) => {
			recordSnapshot(mutableState, "tool_execution_end", context, event.toolCallId);
		});

		pi.on("turn_end", (_event, context) => {
			recordSnapshot(mutableState, "turn_end", context);
		});

		pi.on("agent_settled", (_event, context) => {
			recordSnapshot(mutableState, "agent_settled", context);
		});

		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "Prototype-supplied compacted transcript",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { source: "pi-transcript-conformance" },
			},
		}));

		pi.on("session_compact", (_event, context) => {
			const leaf = context.sessionManager.getLeafEntry();
			mutableState.compactionObserved = {
				leafIsCompaction: leaf?.type === "compaction",
				agentContextWasRebuilt: mutableState.session?.messages.some((message) => message.role === "compactionSummary") === true,
			};
			recordSnapshot(mutableState, "session_compact", context);
		});

		pi.on("session_tree", (event, context) => {
			const sessionFile = requireSessionFile(context.sessionManager);
			const beforeMarker = SessionManager.open(
				sessionFile,
				context.sessionManager.getSessionDir(),
				context.sessionManager.getCwd(),
			);
			// Pi does not persist a bare leaf move; the marker makes the selected parent the physical tail.
			pi.appendEntry(BRANCH_MARKER_TYPE, { selectedLeafId: event.newLeafId });
			const marker = context.sessionManager.getLeafEntry();
			if (marker?.type !== "custom" || marker.customType !== BRANCH_MARKER_TYPE) {
				throw new Error("Branch marker append did not advance the active leaf");
			}
			mutableState.branchMarker = {
				markerId: marker.id,
				parentId: marker.parentId,
				selectedLeafId: event.newLeafId,
				oldLeafId: event.oldLeafId,
				preMarkerReopenedLeafId: beforeMarker.getLeafId(),
			};
			recordSnapshot(mutableState, "session_tree", context, event.newLeafId ?? "root");
		});
	};
}

async function createFauxModelHarness(): Promise<{
	modelRuntime: ModelRuntime;
	model: ReturnType<ReturnType<typeof fauxProvider>["getModel"]>;
	contexts: Context[];
	getCallCount(): number;
}> {
	const contexts: Context[] = [];
	const faux = fauxProvider();
	const captureContext = (context: Context) => {
			contexts.push({
				systemPrompt: context.systemPrompt,
				messages: structuredClone(context.messages),
			});
	};
	faux.setResponses([
		(context) => {
			captureContext(context);
			return fauxAssistantMessage(
				[
					fauxToolCall("slow_probe", {}, { id: "slow-tool" }),
					fauxToolCall("fast_probe", {}, { id: "fast-tool" }),
				],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			captureContext(context);
			return fauxAssistantMessage("steered delivery observed");
		},
	]);

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "prototype-key");

	return {
		modelRuntime,
		model: faux.getModel(),
		contexts,
		getCallCount: () => faux.state.callCount,
	};
}

function recordSnapshot(
	mutableState: MutableHarnessState,
	hook: string,
	context: ExtensionContext,
	eventSubject?: string,
): void {
	mutableState.snapshots.push({
		hook,
		eventSubject,
		branch: context.sessionManager.getBranch().map(describeEntry),
		file: readCompleteFileEntries(context.sessionManager.getSessionFile()).map(describeRawEntry),
		toolExecutionStarts: [...mutableState.toolExecutionStarts],
	});
}

function describeEntry(entry: SessionEntry): string {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") {
			const toolCallIds = assistantToolCallIds(entry.message);
			return `message:assistant:${toolCallIds.join(",") || "text"}`;
		}
		if (entry.message.role === "toolResult") {
			return `message:toolResult:${entry.message.toolCallId}`;
		}
		return `message:${entry.message.role}`;
	}
	if (entry.type === "custom_message") return `custom_message:${entry.customType}`;
	if (entry.type === "custom") return `custom:${entry.customType}`;
	return entry.type;
}

function describeRawEntry(entry: Record<string, unknown>): string {
	if (entry.type === "session") return "session";
	return describeEntry(entry as unknown as SessionEntry);
}

function readCompleteFileEntries(sessionFile: string | undefined): Record<string, unknown>[] {
	if (!sessionFile || !existsSync(sessionFile)) return [];
	const contents = readFileSync(sessionFile, "utf8");
	const completePrefix = contents.endsWith("\n") ? contents : contents.slice(0, contents.lastIndexOf("\n") + 1);
	return completePrefix
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assistantToolCallIds(message: Extract<SessionEntry, { type: "message" }>['message']): string[] {
	if (message.role !== "assistant") return [];
	return message.content.filter((content) => content.type === "toolCall").map((toolCall) => toolCall.id);
}

function resultIds(entries: string[]): string[] {
	return entries.filter((entry) => entry.startsWith("message:toolResult:")).map((entry) => entry.slice("message:toolResult:".length));
}

function requireSessionFile(sessionManager: { getSessionFile(): string | undefined }): string {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Prototype requires a persisted Pi session file");
	return sessionFile;
}

function modelContextContainsDelivery(context: Context): boolean {
	return context.messages.some((message) => {
		if (message.role !== "user") return false;
		if (typeof message.content === "string") return message.content === DELIVERY_CONTENT;
		return message.content.some((content) => content.type === "text" && content.text === DELIVERY_CONTENT);
	});
}

function createDeferredSignal(): DeferredSignal {
	let releasePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		releasePromise = resolve;
	});
	return {
		promise,
		release() {
			releasePromise?.();
		},
	};
}
