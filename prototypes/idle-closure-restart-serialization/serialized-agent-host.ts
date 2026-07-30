import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type AgentSession,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

const EVIDENCE_TYPE = {
	identity: "coordination-prototype:agent-identity",
	outbound: "coordination-prototype:outbound-message",
	retry: "coordination-prototype:message-retry",
	delivery: "coordination-prototype:message-delivery",
} as const;

const TRACE_LIMIT = 18;
const SETTLEMENT_PASSES = 3;

export type AgentId = string;
export type MessageId = string;

export type CoordinationMessage = Readonly<{
	messageId: MessageId;
	workflowId: AgentId;
	senderAgentId: AgentId;
	recipientAgentId: AgentId;
	kind: "message" | "request" | "answer";
	payload: string;
	requestId?: MessageId;
}>;

export type HostSnapshot = {
	scenario: string;
	agents: Array<{
		name: string;
		agentId: string;
		directSpawner: string;
		run: string;
		work: "active" | "idle" | "dormant";
		runsStarted: number;
		runsDisposed: number;
		blockers: string[];
		outboundEvidence: number;
		deliveryEvidence: number;
		retryEvidence: number;
	}>;
	messages: Array<{
		messageId: string;
		kind: CoordinationMessage["kind"];
		from: string;
		to: string;
		deliveries: number;
	}>;
	trace: string[];
};

type AgentIdentity = Readonly<{
	agentId: AgentId;
	workflowId: AgentId;
	workflowOwnerAgentId: AgentId;
	directSpawnerAgentId: AgentId | null;
	creationRequestId: MessageId | null;
}>;

type AgentRecord = {
	name: string;
	identity: AgentIdentity;
	sessionManager: SessionManager;
	lane: SerialLane;
	run?: AgentRun;
	runsStarted: number;
	runsDisposed: number;
};

type AgentRun = {
	incarnation: number;
	phase: "live" | "ending";
	session: AgentSession;
	unsubscribe: () => void;
};

type OutboundEvidence = Readonly<{ message: CoordinationMessage }>;
type RetryEvidence = Readonly<{ requestId: MessageId }>;
type DeliveryEvidence = Readonly<{ message: CoordinationMessage }>;

type DeliveryDisposition = "delivered" | "already_delivered";

class SerialLane {
	#tail: Promise<void> = Promise.resolve();

	run<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	idle(): Promise<void> {
		return this.#tail;
	}
}

export class SerializedAgentHost {
	readonly #modelRuntime: ModelRuntime;
	readonly #model: Model<Api>;
	readonly #cwd: string;
	readonly #agents = new Map<AgentId, AgentRecord>();
	readonly #trace: string[] = [];
	#messageSequence = 0;
	#scenario = "No scenario selected";
	#latestSpawnRequest?: { request: CoordinationMessage; childAgentId: AgentId };

	constructor(modelRuntime: ModelRuntime, model: Model<Api>, cwd = process.cwd()) {
		this.#modelRuntime = modelRuntime;
		this.#model = model;
		this.#cwd = cwd;
	}

	async demonstrateDormantDelivery(): Promise<void> {
		const { owner, worker } = await this.#resetPair("Message starts a dormant Agent");
		const message = this.#newMessage(owner, worker, "message", "Inspect the current task.");
		await this.#commitOutbound(message);
		await this.#queueDelivery(message);
		await this.settle();
	}

	async demonstrateCloseRace(order: "close_first" | "delivery_first"): Promise<void> {
		const scenario = order === "close_first"
			? "Close wins; delivery starts a successor Run"
			: "Delivery wins; the current Run receives it before closing";
		const { owner, worker } = await this.#resetPair(scenario);
		const originalRun = await worker.lane.run(() => this.#startRunInLane(worker, "race setup"));
		const message = this.#newMessage(owner, worker, "message", `Race probe: ${order}`);
		await this.#commitOutbound(message);

		const close = () => worker.lane.run(() =>
			this.#closeIfUnblockedInLane(worker, originalRun.incarnation, "race close candidate"));
		const deliver = () => this.#queueDelivery(message);
		const operations = order === "close_first"
			? [close(), deliver()]
			: [deliver(), close()];
		await Promise.all(operations);
		await this.settle();
	}

	async demonstrateRequestRetry(): Promise<void> {
		const { owner: requester, worker: responder } = await this.#resetPair(
			"Request retry retrieves a committed Answer",
		);
		const request = this.#newMessage(
			requester,
			responder,
			"request",
			"Choose the implementation seam.",
		);
		await this.#commitOutbound(request);
		await this.#queueDelivery(request);
		await this.settle();

		await this.#retryRequest(request);
		const answer = this.#newMessage(
			responder,
			requester,
			"answer",
			"Use one host-local serialization lane per Agent.",
			request.messageId,
		);
		await this.#commitOutbound(answer);
		this.#record("volatile Answer scheduling is dropped before recipient delivery");
		await this.settle();

		await this.#retryRequest(request);
		await this.settle();
	}

	async demonstrateDynamicSpawn(): Promise<void> {
		await this.reset("Dynamic child starts immediately with initial work");
		const owner = this.#createRootAgent("Owner");
		const childSessionManager = SessionManager.inMemory(this.#cwd);
		const childAgentId = childSessionManager.getSessionId();
		const creationRequest = this.#newMessageToAgentId(
			owner,
			childAgentId,
			"request",
			"Inspect the serialization proof and report the result.",
		);

		await this.#commitOutbound(creationRequest);
		const child = this.#registerAgent(
			"Dynamic Child",
			childSessionManager,
			owner.identity.workflowId,
			owner.identity.agentId,
			creationRequest.messageId,
		);
		await child.lane.run(() => this.#startRunInLane(child, "authorized dynamic spawn"));
		this.#record(`${child.name} starts immediately; no approval state is created`);
		await this.#queueDelivery(creationRequest);
		this.#latestSpawnRequest = { request: creationRequest, childAgentId };
		await this.settle();
	}

	async answerLatestSpawnRequest(): Promise<void> {
		const latest = this.#latestSpawnRequest;
		if (!latest) throw new Error("Run the dynamic spawn scenario first");
		const child = this.#requireAgent(latest.childAgentId);
		const owner = this.#requireAgent(latest.request.senderAgentId);
		const answer = this.#newMessage(
			child,
			owner,
			"answer",
			"The child observed the initial work in its Pi transcript.",
			latest.request.messageId,
		);
		await this.#commitOutbound(answer);
		await this.#queueDelivery(answer);
		await this.settle();
	}

	async reset(scenario = "Reset"): Promise<void> {
		const records = [...this.#agents.values()];
		await Promise.all(records.map((record) => record.lane.run(() => this.#disposeRunInLane(record))));
		this.#agents.clear();
		this.#trace.length = 0;
		this.#messageSequence = 0;
		this.#latestSpawnRequest = undefined;
		this.#scenario = scenario;
		this.#record(`scenario: ${scenario}`);
	}

	async settle(): Promise<void> {
		for (let pass = 0; pass < SETTLEMENT_PASSES; pass += 1) {
			await Promise.all([...this.#agents.values()].map((record) => record.lane.idle()));
			await Promise.resolve();
		}
	}

	async shutdown(): Promise<void> {
		await this.reset("Shutdown");
	}

	snapshot(): HostSnapshot {
		const agents = [...this.#agents.values()];
		return {
			scenario: this.#scenario,
			agents: agents.map((record) => {
				const run = record.run;
				return {
					name: record.name,
					agentId: shortId(record.identity.agentId),
					directSpawner: record.identity.directSpawnerAgentId
						? this.#agentName(record.identity.directSpawnerAgentId)
						: "—",
					run: run ? `run-${run.incarnation} · ${run.phase}` : "dormant",
					work: run ? (run.session.isIdle ? "idle" : "active") : "dormant",
					runsStarted: record.runsStarted,
					runsDisposed: record.runsDisposed,
					blockers: this.#requestBlockers(record),
					outboundEvidence: this.#outbound(record).length,
					deliveryEvidence: this.#deliveries(record).length,
					retryEvidence: this.#retries(record).length,
				};
			}),
			messages: this.#allMessages().map((message) => ({
				messageId: shortId(message.messageId),
				kind: message.kind,
				from: this.#agentName(message.senderAgentId),
				to: this.#agentName(message.recipientAgentId),
				deliveries: this.#deliveryCount(message.messageId),
			})),
			trace: [...this.#trace],
		};
	}

	async #resetPair(scenario: string): Promise<{ owner: AgentRecord; worker: AgentRecord }> {
		await this.reset(scenario);
		const owner = this.#createRootAgent("Owner");
		const worker = this.#registerAgent(
			"Worker",
			SessionManager.inMemory(this.#cwd),
			owner.identity.workflowId,
			owner.identity.agentId,
			null,
		);
		return { owner, worker };
	}

	#createRootAgent(name: string): AgentRecord {
		const sessionManager = SessionManager.inMemory(this.#cwd);
		const agentId = sessionManager.getSessionId();
		return this.#registerAgent(name, sessionManager, agentId, null, null);
	}

	#registerAgent(
		name: string,
		sessionManager: SessionManager,
		workflowId: AgentId,
		directSpawnerAgentId: AgentId | null,
		creationRequestId: MessageId | null,
	): AgentRecord {
		const agentId = sessionManager.getSessionId();
		if (this.#agents.has(agentId)) throw new Error(`Agent already registered: ${agentId}`);
		const identity: AgentIdentity = {
			agentId,
			workflowId,
			workflowOwnerAgentId: workflowId,
			directSpawnerAgentId,
			creationRequestId,
		};
		sessionManager.appendCustomMessageEntry(
			EVIDENCE_TYPE.identity,
			`Agent Identity: ${name} (${agentId})`,
			true,
			identity,
		);
		const record: AgentRecord = {
			name,
			identity,
			sessionManager,
			lane: new SerialLane(),
			runsStarted: 0,
			runsDisposed: 0,
		};
		this.#agents.set(agentId, record);
		this.#record(`${name} identity commits (${shortId(agentId)})`);
		return record;
	}

	#newMessage(
		sender: AgentRecord,
		recipient: AgentRecord,
		kind: CoordinationMessage["kind"],
		payload: string,
		requestId?: MessageId,
	): CoordinationMessage {
		return this.#newMessageToAgentId(sender, recipient.identity.agentId, kind, payload, requestId);
	}

	#newMessageToAgentId(
		sender: AgentRecord,
		recipientAgentId: AgentId,
		kind: CoordinationMessage["kind"],
		payload: string,
		requestId?: MessageId,
	): CoordinationMessage {
		this.#messageSequence += 1;
		const messageId = `${sender.identity.agentId}:message:${this.#messageSequence}`;
		return {
			messageId,
			workflowId: sender.identity.workflowId,
			senderAgentId: sender.identity.agentId,
			recipientAgentId,
			kind,
			payload,
			requestId: kind === "request" ? messageId : requestId,
		};
	}

	async #commitOutbound(message: CoordinationMessage): Promise<void> {
		const sender = this.#requireAgent(message.senderAgentId);
		const committingRun = await sender.lane.run(async () => {
			const existing = this.#findOutbound(sender, message.messageId);
			if (existing) return sender.run?.incarnation;
			const run = await this.#startRunInLane(sender, "outbound transcript commit");
			await run.session.sendCustomMessage(
				{
					customType: EVIDENCE_TYPE.outbound,
					content: renderMessage("Outbound", message),
					display: true,
					details: { message } satisfies OutboundEvidence,
				},
				{ triggerTurn: false },
			);
			this.#record(`${sender.name} commits outbound ${message.kind} ${shortId(message.messageId)}`);
			return run.incarnation;
		});
		await sender.lane.run(() =>
			this.#closeIfUnblockedInLane(sender, committingRun, "outbound commit settled"));
	}

	#queueDelivery(message: CoordinationMessage): Promise<DeliveryDisposition> {
		const recipient = this.#requireAgent(message.recipientAgentId);
		return recipient.lane.run(async () => {
			if (this.#findDelivery(recipient, message.messageId)) {
				this.#record(`${recipient.name} suppresses duplicate ${shortId(message.messageId)}`);
				return "already_delivered";
			}

			const run = await this.#startRunInLane(recipient, "inbound scheduling");
			this.#record(
				`${recipient.name} schedules ${shortId(message.messageId)} on run-${run.incarnation}`,
			);
			await run.session.sendCustomMessage(
				{
					customType: EVIDENCE_TYPE.delivery,
					content: renderMessage("Delivery", message),
					display: true,
					details: { message } satisfies DeliveryEvidence,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			if (!this.#findDelivery(recipient, message.messageId)) {
				throw new Error(`Pi did not commit delivery ${message.messageId}`);
			}
			this.#record(
				`${recipient.name} transcript proves ${shortId(message.messageId)} on run-${run.incarnation}`,
			);
			return "delivered";
		});
	}

	async #retryRequest(request: CoordinationMessage): Promise<void> {
		if (request.kind !== "request") throw new Error("Only a Request can be retried");
		const requester = this.#requireAgent(request.senderAgentId);
		const responder = this.#requireAgent(request.recipientAgentId);
		await requester.lane.run(async () => {
			const run = await this.#startRunInLane(requester, "Request retry commit");
			await run.session.sendCustomMessage(
				{
					customType: EVIDENCE_TYPE.retry,
					content: `Retry Request ${request.messageId}`,
					display: true,
					details: { requestId: request.messageId } satisfies RetryEvidence,
				},
				{ triggerTurn: false },
			);
			this.#record(`${requester.name} commits retry for ${shortId(request.messageId)}`);
		});

		const answer = this.#outbound(responder)
			.map(({ message }) => message)
			.find((message) => message.kind === "answer" && message.requestId === request.messageId);
		if (answer) {
			this.#record(`retry finds committed Answer ${shortId(answer.messageId)} in ${responder.name}`);
			await this.#queueDelivery(answer);
		} else {
			this.#record("retry finds no Answer; it reschedules the same Request identity");
			await this.#queueDelivery(request);
		}
	}

	async #startRunInLane(record: AgentRecord, cause: string): Promise<AgentRun> {
		if (record.run) return record.run;
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.#cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "A deterministic prototype model acknowledges coordination input.",
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.#cwd,
			modelRuntime: this.#modelRuntime,
			model: this.#model,
			thinkingLevel: "off",
			noTools: "all",
			resourceLoader,
			sessionManager: record.sessionManager,
			settingsManager,
		});
		const incarnation = record.runsStarted + 1;
		const run: AgentRun = {
			incarnation,
			phase: "live",
			session,
			unsubscribe: () => undefined,
		};
		run.unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			this.#record(`${record.name} run-${incarnation} reaches Pi agent_settled`);
			void record.lane.run(() =>
				this.#closeIfUnblockedInLane(record, incarnation, "automatic Idle close"));
		});
		record.run = run;
		record.runsStarted = incarnation;
		this.#record(`${record.name} starts run-${incarnation} (${cause})`);
		return run;
	}

	#closeIfUnblockedInLane(
		record: AgentRecord,
		incarnation: number | undefined,
		cause: string,
	): void {
		const run = record.run;
		if (!run || incarnation === undefined || run.incarnation !== incarnation) {
			this.#record(`${record.name} ignores stale close candidate for ${formatRun(incarnation)}`);
			return;
		}
		if (!run.session.isIdle) {
			this.#record(`${record.name} retains run-${incarnation}; Pi work is active`);
			return;
		}
		const blockers = this.#requestBlockers(record);
		if (blockers.length > 0) {
			this.#record(`${record.name} retains run-${incarnation}; ${blockers.join(", ")}`);
			return;
		}

		run.phase = "ending";
		run.unsubscribe();
		run.session.dispose();
		record.run = undefined;
		record.runsDisposed += 1;
		this.#record(`${record.name} disposes run-${incarnation} cleanly (${cause})`);
	}

	#disposeRunInLane(record: AgentRecord): void {
		const run = record.run;
		if (!run) return;
		run.phase = "ending";
		run.unsubscribe();
		run.session.dispose();
		record.run = undefined;
		record.runsDisposed += 1;
	}

	#requestBlockers(record: AgentRecord): string[] {
		const blockers: string[] = [];
		for (const { message: request } of this.#outbound(record)) {
			if (request.kind !== "request") continue;
			const answerDelivered = this.#deliveries(record).some(
				({ message }) => message.kind === "answer" && message.requestId === request.messageId,
			);
			if (!answerDelivered) blockers.push(`waiting for ${shortId(request.messageId)}`);
		}
		for (const { message: request } of this.#deliveries(record)) {
			if (request.kind !== "request") continue;
			const answerCommitted = this.#outbound(record).some(
				({ message }) => message.kind === "answer" && message.requestId === request.messageId,
			);
			if (!answerCommitted) blockers.push(`owes Answer to ${shortId(request.messageId)}`);
		}
		return blockers;
	}

	#outbound(record: AgentRecord): OutboundEvidence[] {
		return evidenceDetails<OutboundEvidence>(record.sessionManager, EVIDENCE_TYPE.outbound);
	}

	#retries(record: AgentRecord): RetryEvidence[] {
		return evidenceDetails<RetryEvidence>(record.sessionManager, EVIDENCE_TYPE.retry);
	}

	#deliveries(record: AgentRecord): DeliveryEvidence[] {
		return evidenceDetails<DeliveryEvidence>(record.sessionManager, EVIDENCE_TYPE.delivery);
	}

	#findOutbound(record: AgentRecord, messageId: MessageId): CoordinationMessage | undefined {
		return this.#outbound(record).find(({ message }) => message.messageId === messageId)?.message;
	}

	#findDelivery(record: AgentRecord, messageId: MessageId): CoordinationMessage | undefined {
		return this.#deliveries(record).find(({ message }) => message.messageId === messageId)?.message;
	}

	#allMessages(): CoordinationMessage[] {
		const byId = new Map<MessageId, CoordinationMessage>();
		for (const record of this.#agents.values()) {
			for (const { message } of this.#outbound(record)) byId.set(message.messageId, message);
		}
		return [...byId.values()];
	}

	#deliveryCount(messageId: MessageId): number {
		let count = 0;
		for (const record of this.#agents.values()) {
			count += this.#deliveries(record).filter(({ message }) => message.messageId === messageId).length;
		}
		return count;
	}

	#requireAgent(agentId: AgentId): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`Unknown Agent: ${agentId}`);
		return record;
	}

	#agentName(agentId: AgentId): string {
		return this.#agents.get(agentId)?.name ?? `unknown:${shortId(agentId)}`;
	}

	#record(message: string): void {
		this.#trace.push(message);
		if (this.#trace.length > TRACE_LIMIT) this.#trace.shift();
	}
}

function evidenceDetails<T>(sessionManager: SessionManager, customType: string): T[] {
	return sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "custom_message" || entry.customType !== customType) return [];
		return [entry.details as T];
	});
}

function renderMessage(prefix: string, message: CoordinationMessage): string {
	return `${prefix} ${message.kind} ${message.messageId}\n${message.payload}`;
}

function shortId(identity: string): string {
	const tail = identity.split(":").at(-1) ?? identity;
	return tail.length > 10 ? tail.slice(-8) : tail;
}

function formatRun(incarnation: number | undefined): string {
	return incarnation === undefined ? "no Run" : `run-${incarnation}`;
}
