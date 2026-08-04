import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	InProcessOwnerRunHost,
	type OwnerRunState,
} from "../runtime/in-process-owner-run-host.ts";

export type AgentStatus = Readonly<{
	agentId: string;
	workflowId: string;
	label: string;
	directSpawnerAgentId: null;
	run: OwnerRunState;
}>;

export type OwnerCoordinatorView = Readonly<{
	status(agentId?: string): AgentStatus;
}>;

export class WorkflowCoordinator {
	readonly #identity: OwnerIdentity;
	readonly #host: InProcessOwnerRunHost;
	#shutdownPromise: Promise<void> | undefined;

	constructor(runtime: AgentSessionRuntime, identity: OwnerIdentity) {
		this.#identity = identity;
		this.#host = new InProcessOwnerRunHost(runtime);
	}

	forAgent(agentId: string): OwnerCoordinatorView {
		if (agentId !== this.#identity.agentId) {
			throw new Error(`Unknown Agent identity: ${agentId}`);
		}
		return Object.freeze({
			status: (targetAgentId?: string) => this.#statusFor(agentId, targetAgentId),
		});
	}

	shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		this.#shutdownPromise ??= this.#host.shutdown(disposeNativeRuntime);
		return this.#shutdownPromise;
	}

	#statusFor(callerAgentId: string, targetAgentId = callerAgentId): AgentStatus {
		if (targetAgentId !== callerAgentId || targetAgentId !== this.#identity.agentId) {
			throw new Error(`Unknown Agent identity: ${targetAgentId}`);
		}
		return {
			agentId: this.#identity.agentId,
			workflowId: this.#identity.workflowId,
			label: this.#identity.configuration.label,
			directSpawnerAgentId: null,
			run: this.#host.observe(),
		};
	}
}
