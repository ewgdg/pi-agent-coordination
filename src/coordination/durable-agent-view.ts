import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import type { DurableAgentView } from "../presentation/agent-view-surface.ts";

export class DurableAgentViewAttachment implements DurableAgentView {
	#agentId: string;
	#label: string;
	readonly #requestClose: () => Promise<void>;
	readonly #reportFailure: (error: unknown) => void;
	readonly #presentationHandlers = new Set<() => void | Promise<void>>();
	readonly #closeHandlers = new Set<() => void>();
	#projection: TerminalProjection;
	#closed = false;

	constructor(options: {
		agentId: string;
		label: string;
		projection: TerminalProjection;
		requestClose(): Promise<void>;
		reportFailure(error: unknown): void;
	}) {
		this.#agentId = options.agentId;
		this.#label = options.label;
		this.#projection = options.projection;
		this.#requestClose = options.requestClose;
		this.#reportFailure = options.reportFailure;
	}

	get agentId(): string {
		return this.#agentId;
	}

	get label(): string {
		return this.#label;
	}

	projection(): TerminalProjection {
		return this.#projection;
	}

	/** A handler settles after its presentation has handed over to the new projection. */
	addPresentationHandler(handler: () => void | Promise<void>): () => void {
		if (this.#closed) return () => undefined;
		this.#presentationHandlers.add(handler);
		return () => this.#presentationHandlers.delete(handler);
	}

	addCloseHandler(handler: () => void): () => void {
		if (this.#closed) {
			handler();
			return () => undefined;
		}
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	close(): Promise<void> {
		return this.#requestClose();
	}

	fail(error: unknown): void {
		if (this.#closed) return;
		this.#reportFailure(error);
	}

	async retarget(options: {
		agentId: string;
		label: string;
		projection: TerminalProjection;
	}): Promise<void> {
		if (this.#closed) return;
		this.#agentId = options.agentId;
		this.#label = options.label;
		this.#projection = options.projection;
		await Promise.all([...this.#presentationHandlers].map((present) => present()));
	}

	settleClosed(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#presentationHandlers.clear();
		for (const handler of this.#closeHandlers) handler();
		this.#closeHandlers.clear();
	}
}
