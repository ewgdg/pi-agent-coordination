import type { Static } from "typebox";
import { Check } from "typebox/value";

import type { ControlRequest } from "../control/agent-control-channel.ts";
import {
	agentControlMethods,
	agentControlProtocol,
	type AgentControlMethod,
	type RemoteAgentSelectorAction,
	type RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import type { ParticipantLifecycleHandlers } from "../pi-integration/participant-lifecycle.ts";
import type {
	ParticipantCoordinationRole,
	ParticipantCoordinationToolHandlers,
} from "../tools/participant-coordination-tools.ts";

type RemoteParticipantRole = Exclude<ParticipantCoordinationRole, "owner">;
type MethodRequest<M extends AgentControlMethod> = Static<
	(typeof agentControlMethods)[M]["request"]
>;
type MethodResponse<M extends AgentControlMethod> = Static<
	(typeof agentControlMethods)[M]["response"]
>;

export type ChildParticipantControlRequester = <M extends AgentControlMethod>(
	method: M,
	payload: MethodRequest<M>,
	signal?: AbortSignal,
) => Promise<MethodResponse<M>>;

/** Agent-scoped Owner behavior; transport and framing stay outside this seam. */
export type OwnerParticipantRequestHandlers<Role extends RemoteParticipantRole> = Readonly<{
	lifecycle: ParticipantLifecycleHandlers;
	coordination: ParticipantCoordinationToolHandlers<Role>;
	presentation: OwnerParticipantPresentationHandlers;
}>;

export type OwnerParticipantPresentationHandlers = Readonly<{
	snapshot(): RemoteAgentSelectorSnapshot;
	select(action: RemoteAgentSelectorAction, signal: AbortSignal): Promise<void>;
}>;

export type ControlBackedChildPresentationHandlers = Readonly<{
	snapshot(): Promise<RemoteAgentSelectorSnapshot>;
	select(action: RemoteAgentSelectorAction, signal?: AbortSignal): Promise<void>;
}>;

export type ControlBackedChildParticipantHandlers<Role extends RemoteParticipantRole> = Readonly<{
	lifecycle: ParticipantLifecycleHandlers;
	coordination: ParticipantCoordinationToolHandlers<Role>;
}>;

type CommonChildCoordinationHandlers = Pick<
	ParticipantCoordinationToolHandlers<"ordinary">,
	"observe" | "message" | "control"
>;

export function createControlBackedChildPresentationHandlers(
	request: ChildParticipantControlRequester,
): ControlBackedChildPresentationHandlers {
	return {
		snapshot: () => request("presentation.agents.snapshot", {}),
		async select(action, signal) {
			await request("presentation.agents.select", action, signal);
		},
	};
}

/** Build the child registrars' process-neutral proxies over one Control requester. */
export function createControlBackedChildParticipantHandlers(
	role: "ordinary",
	request: ChildParticipantControlRequester,
): ControlBackedChildParticipantHandlers<"ordinary">;
export function createControlBackedChildParticipantHandlers(
	role: "moderator",
	request: ChildParticipantControlRequester,
): ControlBackedChildParticipantHandlers<"moderator">;
export function createControlBackedChildParticipantHandlers(
	role: RemoteParticipantRole,
	request: ChildParticipantControlRequester,
): ControlBackedChildParticipantHandlers<"ordinary"> | ControlBackedChildParticipantHandlers<"moderator"> {
	const lifecycle: ParticipantLifecycleHandlers = {
		async executionStarted() {
			await request("runtime.executionBegin", {});
		},
		async humanInputSubmitted(input) {
			return (await request("runtime.humanInput", {
				text: input.text,
				...(input.images === undefined ? {} : { images: input.images }),
			})).resumed;
		},
		async humanInputMode() {
			return (await request("runtime.humanInputMode", {})).mode;
		},
		async humanToolResultCommitting(input) {
			return (await request("runtime.guardHumanToolResult", input)).result ?? undefined;
		},
		async toolExecutionStarted(input) {
			await request("runtime.toolExecutionStart", input);
		},
		async safeBoundaryReached() {
			await request("runtime.safeBoundary", {});
		},
		async executionEnded() {
			await request("runtime.executionEnd", {});
		},
	};
	const common: CommonChildCoordinationHandlers = {
		observe: (input) => request("coordination.observe", input),
		message: (toolCallId, input) =>
			request("coordination.message", { toolCallId, input }),
		control: (toolCallId, input) =>
			request("coordination.control", { toolCallId, input }),
	};
	if (role === "ordinary") {
		const coordination: ParticipantCoordinationToolHandlers<"ordinary"> = {
			...common,
			spawn: (toolCallId, input) =>
				request("coordination.spawn", { toolCallId, input }),
			askUserQuestion: (toolCallId, input, signal) =>
				request("coordination.askHuman", { toolCallId, input }, signal),
		};
		return { lifecycle, coordination };
	}
	const coordination: ParticipantCoordinationToolHandlers<"moderator"> = {
		...common,
		askUserQuestion: (toolCallId, input, signal) =>
			request("coordination.askHuman", { toolCallId, input }, signal),
		moderatorControl: (toolCallId, input) =>
			request("coordination.moderatorControl", { toolCallId, input }),
	};
	return { lifecycle, coordination };
}

/** Dispatch one authenticated child intention into its scoped Owner handlers. */
export async function dispatchParticipantRequestToOwner(
	handlers:
		| OwnerParticipantRequestHandlers<"ordinary">
		| OwnerParticipantRequestHandlers<"moderator">
		| undefined,
	request: ControlRequest<typeof agentControlProtocol>,
): Promise<unknown> {
	if (!handlers) throw new Error("child_runtime_owner_request_unavailable");
	assertValidRequest(request);
	let response: unknown;
	switch (request.method) {
		case "runtime.executionBegin":
			await handlers.lifecycle.executionStarted();
			response = {};
			break;
		case "runtime.humanInput":
			response = {
				resumed: await handlers.lifecycle.humanInputSubmitted({
					text: request.payload.text,
					images: request.payload.images,
				}),
			};
			break;
		case "runtime.humanInputMode":
			response = { mode: await handlers.lifecycle.humanInputMode() };
			break;
		case "runtime.guardHumanToolResult":
			response = {
				result: await handlers.lifecycle.humanToolResultCommitting({
					message: request.payload.message,
				}) ?? null,
			};
			break;
		case "runtime.toolExecutionStart":
			await handlers.lifecycle.toolExecutionStarted(request.payload);
			response = {};
			break;
		case "runtime.safeBoundary":
			await handlers.lifecycle.safeBoundaryReached();
			response = {};
			break;
		case "runtime.executionEnd":
			await handlers.lifecycle.executionEnded();
			response = {};
			break;
		case "coordination.observe":
			response = await handlers.coordination.observe(request.payload);
			break;
		case "coordination.message":
			response = await handlers.coordination.message(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "coordination.control":
			response = await handlers.coordination.control(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "coordination.spawn":
			if (!("spawn" in handlers.coordination)) throw unavailableForRole(request.method);
			response = await handlers.coordination.spawn(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "coordination.askHuman":
			if (!("askUserQuestion" in handlers.coordination)) throw unavailableForRole(request.method);
			response = await handlers.coordination.askUserQuestion(
				request.payload.toolCallId,
				request.payload.input,
				request.signal,
			);
			break;
		case "coordination.moderatorControl":
			if (!("moderatorControl" in handlers.coordination)) throw unavailableForRole(request.method);
			response = await handlers.coordination.moderatorControl(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "presentation.agents.snapshot":
			response = handlers.presentation.snapshot();
			break;
		case "presentation.agents.select":
			await handlers.presentation.select(request.payload, request.signal);
			response = {};
			break;
		default:
			throw new Error(`child_runtime_owner_request_unavailable: ${request.method}`);
	}
	assertValidResponse(request.method, response);
	return response;
}

function assertValidRequest(request: ControlRequest<typeof agentControlProtocol>): void {
	const definition = agentControlMethods[request.method];
	if (!definition || !Check(definition.request, request.payload)) {
		throw new Error(`child_runtime_owner_request_invalid: ${request.method}`);
	}
}

function assertValidResponse(method: AgentControlMethod, response: unknown): void {
	if (!Check(agentControlMethods[method].response, response)) {
		throw new Error(`child_runtime_owner_response_invalid: ${method}`);
	}
}

function unavailableForRole(method: string): Error {
	return new Error(`child_runtime_owner_request_forbidden: ${method}`);
}
