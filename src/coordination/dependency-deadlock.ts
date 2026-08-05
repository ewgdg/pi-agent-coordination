export type UnresolvedAgentRequest = Readonly<{
	requestId: string;
	fromAgentId: string;
	targetAgentId: string;
}>;

export type DependencyDeadlockComponent = Readonly<{
	agentIds: readonly string[];
	requestIds: readonly string[];
}>;

export function detectDependencyDeadlocks(options: {
	eligibleAgentIds: readonly string[];
	requests: readonly UnresolvedAgentRequest[];
}): readonly DependencyDeadlockComponent[] {
	const eligibleAgentIds = [...new Set(options.eligibleAgentIds)].sort();
	const eligible = new Set(eligibleAgentIds);
	const requestById = new Map<string, UnresolvedAgentRequest>();
	for (const request of options.requests) {
		validateRequest(request);
		if (requestById.has(request.requestId)) {
			throw new Error(
				`invariant_violation: duplicate unresolved Request ${request.requestId}`,
			);
		}
		requestById.set(request.requestId, request);
	}
	const requests = [...requestById.values()];
	const targetsByAgentId = new Map(
		eligibleAgentIds.map((agentId) => [agentId, new Set<string>()]),
	);
	for (const request of requests) {
		if (eligible.has(request.fromAgentId) && eligible.has(request.targetAgentId)) {
			targetsByAgentId.get(request.fromAgentId)!.add(request.targetAgentId);
		}
	}

	const components = stronglyConnectedComponents(eligibleAgentIds, targetsByAgentId);
	return components.flatMap((agentIds) => {
		const members = new Set(agentIds);
		const incidentRequests = requests.filter(
			(request) => members.has(request.fromAgentId) || members.has(request.targetAgentId),
		);
		const isCycle = agentIds.length > 1 || incidentRequests.some(
			(request) =>
				request.fromAgentId === agentIds[0] && request.targetAgentId === agentIds[0],
		);
		const isClosed = incidentRequests.length > 0 && incidentRequests.every(
			(request) => members.has(request.fromAgentId) && members.has(request.targetAgentId),
		);
		if (!isCycle || !isClosed) return [];
		return [{
			agentIds,
			requestIds: incidentRequests.map(({ requestId }) => requestId).sort(),
		}];
	}).sort((left, right) => compareStringArrays(left.agentIds, right.agentIds));
}

function stronglyConnectedComponents(
	agentIds: readonly string[],
	targetsByAgentId: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
	let nextIndex = 0;
	const indexByAgentId = new Map<string, number>();
	const lowLinkByAgentId = new Map<string, number>();
	const stack: string[] = [];
	const stacked = new Set<string>();
	const components: string[][] = [];

	const visit = (agentId: string): void => {
		const index = nextIndex;
		nextIndex += 1;
		indexByAgentId.set(agentId, index);
		lowLinkByAgentId.set(agentId, index);
		stack.push(agentId);
		stacked.add(agentId);

		for (const targetAgentId of targetsByAgentId.get(agentId) ?? []) {
			if (!indexByAgentId.has(targetAgentId)) {
				visit(targetAgentId);
				lowLinkByAgentId.set(
					agentId,
					Math.min(
						lowLinkByAgentId.get(agentId)!,
						lowLinkByAgentId.get(targetAgentId)!,
					),
				);
			} else if (stacked.has(targetAgentId)) {
				lowLinkByAgentId.set(
					agentId,
					Math.min(
						lowLinkByAgentId.get(agentId)!,
						indexByAgentId.get(targetAgentId)!,
					),
				);
			}
		}

		if (lowLinkByAgentId.get(agentId) !== index) return;
		const component: string[] = [];
		while (stack.length > 0) {
			const member = stack.pop()!;
			stacked.delete(member);
			component.push(member);
			if (member === agentId) break;
		}
		components.push(component.sort());
	};

	for (const agentId of agentIds) {
		if (!indexByAgentId.has(agentId)) visit(agentId);
	}
	return components;
}

function validateRequest(request: UnresolvedAgentRequest): void {
	for (const [field, value] of Object.entries(request)) {
		if (value.length === 0 || value.includes("\0")) {
			throw new Error(`invariant_violation: unresolved Request ${field} is invalid`);
		}
	}
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const order = left[index]!.localeCompare(right[index]!);
		if (order !== 0) return order;
	}
	return left.length - right.length;
}
