import type { PiNativeAgentProjection } from "../pi-integration/native-agent-projection.ts";
import type { DurableAgentView } from "../presentation/agent-view-surface.ts";

export class DurableAgentViewAttachment implements DurableAgentView {
	#agentId: string;
	#label: string;
	readonly #requestClose: () => Promise<void>;
	readonly #reportFailure: (error: unknown) => void;
	readonly #changeHandlers = new Set<() => void>();
	readonly #closeHandlers = new Set<() => void>();
	#projection: PiNativeAgentProjection;
	#removeProjectionChangeHandler: () => void;
	#closed = false;

	constructor(options: {
		agentId: string;
		label: string;
		projection: PiNativeAgentProjection;
		requestClose(): Promise<void>;
		reportFailure(error: unknown): void;
	}) {
		this.#agentId = options.agentId;
		this.#label = options.label;
		this.#projection = options.projection;
		this.#requestClose = options.requestClose;
		this.#reportFailure = options.reportFailure;
		this.#removeProjectionChangeHandler = this.#observeProjection(
			options.projection,
		);
	}

	get agentId(): string {
		return this.#agentId;
	}

	get label(): string {
		return this.#label;
	}

	projection(): PiNativeAgentProjection {
		return this.#projection;
	}

	addChangeHandler(handler: () => void): () => void {
		if (this.#closed) return () => undefined;
		this.#changeHandlers.add(handler);
		return () => this.#changeHandlers.delete(handler);
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

	replaceProjection(projection: PiNativeAgentProjection): void {
		if (this.#closed) return;
		if (projection === this.#projection) return;
		this.#removeProjectionChangeHandler();
		this.#projection = projection;
		this.#removeProjectionChangeHandler = this.#observeProjection(projection);
		this.#notifyChanged();
	}

	retarget(options: {
		agentId: string;
		label: string;
		projection: PiNativeAgentProjection;
	}): void {
		if (this.#closed) return;
		this.#removeProjectionChangeHandler();
		this.#agentId = options.agentId;
		this.#label = options.label;
		this.#projection = options.projection;
		this.#removeProjectionChangeHandler = this.#observeProjection(
			options.projection,
		);
		this.#notifyChanged();
	}

	settleClosed(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#removeProjectionChangeHandler();
		this.#changeHandlers.clear();
		for (const handler of this.#closeHandlers) handler();
		this.#closeHandlers.clear();
	}

	#observeProjection(projection: PiNativeAgentProjection): () => void {
		return projection.addChangeHandler(() => this.#notifyChanged());
	}

	#notifyChanged(): void {
		if (this.#closed) return;
		for (const handler of this.#changeHandlers) handler();
	}
}
