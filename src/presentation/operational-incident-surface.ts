import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import {
	MAX_AUTOMATIC_MODERATOR_ATTEMPTS,
	type OperationalIncidentAttention,
	type OperationalIncidentPresentation,
} from "../coordination/operational-incidents.ts";

const ATTENTION_STATUS_KEY = "agent-coordination-operational-attention";
const ATTENTION_WIDGET_KEY = "agent-coordination-operational-attention";

export class OperationalIncidentSurface implements OperationalIncidentPresentation {
	readonly #attentionByConditionKey = new Map<string, OperationalIncidentAttention>();
	readonly #ui: ExtensionUIContext;

	constructor(ui: ExtensionUIContext) {
		this.#ui = ui;
	}

	present(conditionKey: string, attention: OperationalIncidentAttention): void {
		this.#attentionByConditionKey.set(conditionKey, attention);
		this.#render();
	}

	dismiss(conditionKey: string): void {
		if (!this.#attentionByConditionKey.delete(conditionKey)) return;
		this.#render();
	}

	items(): readonly OperationalIncidentAttention[] {
		return [...this.#attentionByConditionKey.values()];
	}

	#render(): void {
		const attention = this.items();
		if (attention.length === 0) {
			this.#ui.setStatus(ATTENTION_STATUS_KEY, undefined);
			this.#ui.setWidget(ATTENTION_WIDGET_KEY, undefined);
			return;
		}
		this.#ui.setStatus(
			ATTENTION_STATUS_KEY,
			`${attention.length} Operational Incident${attention.length === 1 ? "" : "s"} · ATTENTION`,
		);
		this.#ui.setWidget(
			ATTENTION_WIDGET_KEY,
			[
				`Operational Attention · ${attention.length}`,
				...attention.flatMap((item) => {
					const requests = operationalIncidentRequestEvidence(item);
					return [
						`  ${formatOperationalIncidentHeadline(item)}`,
						`    Requests · ${requests.total}`,
						...requests.sources.map(
							(pointer) =>
								`      Request · ${pointer.agentId} · ${pointer.entryId} · ${pointer.toolCallId}`,
						),
						...item.diagnostics.slice(0, MAX_AUTOMATIC_MODERATOR_ATTEMPTS).map(
							(pointer) =>
								`    Diagnostic · ${pointer.agentId} · ${pointer.entryId}`,
						),
					];
				}),
			],
			{ placement: "aboveEditor" },
		);
	}
}

export function formatOperationalIncidentHeadline(
	attention: OperationalIncidentAttention,
): string {
	const run = attention.trigger.kind === "run_failure"
		? ` · Run ${attention.trigger.runSequence}`
		: "";
	return `${formatOperationalIncidentKind(attention.trigger.kind)} · ${attention.affectedAgentIds.join(", ")}${run}`;
}

export function operationalIncidentRequestEvidence(
	attention: OperationalIncidentAttention,
) {
	if (attention.trigger.kind === "operation_review") {
		return { total: 0, sources: [] };
	}
	return attention.trigger.kind === "dependency_deadlock"
		? attention.trigger.requests
		: attention.trigger.obligations;
}

export function formatOperationalIncidentKind(
	kind: OperationalIncidentAttention["trigger"]["kind"],
): string {
	return kind.split("_").map(
		(word) => word[0]!.toUpperCase() + word.slice(1),
	).join(" ");
}
