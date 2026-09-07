import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { allocateWorkflowId } from "../src/protocol/workflow-ids.ts";

const execute = promisify(execFile);

test("durable Workflow counters retain assignments across processes and separate domains and scopes", async () => {
 const directory = mkdtempSync(join(tmpdir(), "workflow-ids-"));
 const allocate = (workflowId: string, domain: "a" | "m", source: string) =>
  allocateWorkflowId({ directory, workflowId, domain, source });
 assert.equal(allocate("workflow-one", "a", "owner-session"), "a1");
 assert.equal(allocate("workflow-one", "m", "first-call"), "m1");
 assert.equal(allocate("workflow-two", "a", "different-owner"), "a1");
 const moduleUrl = new URL("../src/protocol/workflow-ids.ts", import.meta.url).href;
 const results = await Promise.all(Array.from({ length: 4 }, (_, worker) => execute(process.execPath, [
  "--input-type=module", "-e",
  `import { allocateWorkflowId } from ${JSON.stringify(moduleUrl)};
   const options = ${JSON.stringify({ directory, workflowId: "workflow-one", domain: "m" })};
   console.log(JSON.stringify(Array.from({length: 8}, (_, i) => allocateWorkflowId({...options, source: 'worker-${worker}-' + i}))));
   console.log(allocateWorkflowId({...options, source: 'first-call'}));`,
 ])));
 const ids = results.flatMap(({ stdout }) => {
  const [line, retry] = stdout.trim().split("\n");
  assert.equal(retry, "m1");
  return JSON.parse(line!) as string[];
 });
 assert.equal(new Set(ids).size, 32);
 assert.equal(allocate("workflow-one", "m", "after-restart"), "m34");
 assert.equal(allocate("workflow-one", "a", "next-session"), "a2");
});

test("Moderator resolution accepts Workflow-scoped tool evidence and rejects an invalid scope", async () => {
 const { validateModeratorControlInput } = await import("../src/protocol/moderator-control.ts");
 const evidence = { workflowId: "workflow", agentId: "a2", entryId: "entry", toolCallId: "call" };
 const input = { operation: "resolve", summary: "Done", rationale: "Verified", evidencePointers: [evidence] };
 assert.deepEqual(validateModeratorControlInput(input), input);
 assert.throws(() => validateModeratorControlInput({ ...input, evidencePointers: [{ ...evidence, workflowId: null }] }));
});

test("a foreign Delivery cannot resolve a local Request with the same Message ID", async () => {
 const { SessionManager } = await import("@earendil-works/pi-coding-agent");
 const { randomUUID } = await import("node:crypto");
 const { resolveMessageIdentity } = await import("../src/protocol/identities.ts");
 const { createMessageDelivery, inspectMessageDeliveries } = await import("../src/protocol/message-delivery.ts");
 const { transcriptFromSessionManager } = await import("../src/pi-integration/session-manager-transcript.ts");
 const manager = SessionManager.inMemory(process.cwd());
 const workflowId = manager.getSessionId();
 manager.appendCustomEntry("agent-coordination.identity", { agentId: "a1", workflowId, sessionId: workflowId });
 const local = { workflowId, agentId: "a1", entryId: "entry", toolCallId: "call" };
 const foreign = { ...local, workflowId: randomUUID() };
 assert.equal(resolveMessageIdentity(local), "m1");
 assert.equal(resolveMessageIdentity(foreign), "m1");
 const delivery = createMessageDelivery([{ source: foreign, projection: { kind: "request", requestMessageId: "m1", fromAgentId: "a1", question: "Foreign work" } }]);
 manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
 assert.throws(() => inspectMessageDeliveries({ recipientAgentId: "a1", transcript: transcriptFromSessionManager(manager).inspect() }), /Workflow/);
});
