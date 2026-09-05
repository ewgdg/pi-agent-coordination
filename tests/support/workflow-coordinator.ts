import { WorkflowCoordinator } from "../../src/coordination/workflow-coordinator.ts";
import type { OwnerIdentity } from "../../src/protocol/owner-identity.ts";
import type { TestOwnerHost } from "./pi-host.ts";

export async function createTestWorkflowCoordinator(
	host: TestOwnerHost,
	identity: OwnerIdentity,
	options: ConstructorParameters<typeof WorkflowCoordinator>[2],
): Promise<WorkflowCoordinator> {
	const coordinator = new WorkflowCoordinator(host.runtime, identity, options);
	host.deferCleanup(() => coordinator.shutdown(async () => undefined));
	await coordinator.initialize();
	return coordinator;
}
