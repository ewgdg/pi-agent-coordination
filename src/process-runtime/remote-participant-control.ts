import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Check } from "typebox/value";

import type { ControlRequest } from "../control/agent-control-channel.ts";
import {
	agentControlMethods,
	agentControlProtocol,
	type AgentControlMethod,
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

export type ParticipantControlRequester = <M extends AgentControlMethod>(
	method: M,
	payload: MethodRequest<M>,
	signal?: AbortSignal,
) => Promise<MethodResponse<M>>;

/** Agent-scoped Owner behavior; transport and framing stay outside this seam. */
export type PiChildOwnerRequestHandlers<Role extends RemoteParticipantRole> = Readonly<{
	lifecycle: ParticipantLifecycleHandlers;
	coordination: ParticipantCoordinationToolHandlers<Role>;
}>;

/** Build the process-neutral registrars' handlers over one child Control requester. */
export function createControlBackedParticipantHandlers<Role extends RemoteParticipantRole>(
	role: Role,
	request: ParticipantControlRequester,
): PiChildOwnerRequestHandlers<Role> {
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
	const common = {
		observe: (input: Parameters<ParticipantCoordinationToolHandlers<Role>["observe"]>[0]) =>
			request("coordination.observe", input),
		message: (
			toolCallId: string,
			input: Parameters<ParticipantCoordinationToolHandlers<Role>["message"]>[1],
		) => request("coordination.message", { toolCallId, input }),
		control: (
			toolCallId: string,
			input: Parameters<ParticipantCoordinationToolHandlers<Role>["control"]>[1],
		) => request("coordination.control", { toolCallId, input }),
	};
	const coordination = role === "ordinary"
		? {
			...common,
			spawn: (toolCallId: string, input: MethodRequest<"coordination.spawn">["input"]) =>
				request("coordination.spawn", { toolCallId, input }),
			askUserQuestion: (
				toolCallId: string,
				input: MethodRequest<"coordination.askHuman">["input"],
				signal: AbortSignal | undefined,
			) => request("coordination.askHuman", { toolCallId, input }, signal),
		}
		: {
			...common,
			askUserQuestion: (
				toolCallId: string,
				input: MethodRequest<"coordination.askHuman">["input"],
				signal: AbortSignal | undefined,
			) => request("coordination.askHuman", { toolCallId, input }, signal),
			moderatorControl: (
				toolCallId: string,
				input: MethodRequest<"coordination.moderatorControl">["input"],
			) => request("coordination.moderatorControl", { toolCallId, input }),
		};
	return {
		lifecycle,
		coordination: coordination as unknown as ParticipantCoordinationToolHandlers<Role>,
	};
}

/** Dispatch one authenticated child intention into its scoped Owner handlers. */
export async function dispatchOwnerParticipantRequest<Role extends RemoteParticipantRole>(
	handlers: PiChildOwnerRequestHandlers<Role> | undefined,
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
					message: request.payload.message as MessageEndEvent["message"],
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
