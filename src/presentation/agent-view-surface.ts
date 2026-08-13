import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

import type { TerminalProjection } from "./terminal-projection.ts";
import {
	createProcessPhysicalTerminalPort,
	PhysicalTerminalAttachment,
	type PhysicalTerminalPort,
} from "./physical-terminal-attachment.ts";

type AgentTerminalAttachment = Readonly<{
	attach(projection: TerminalProjection): Promise<void>;
	dispatchInput(data: string): void;
	close(): void;
}>;

export type PhysicalAgentViewSurface = Readonly<{
	ready: Promise<void>;
	closed: Promise<void>;
	suspend(): Promise<void>;
	resume(): Promise<void>;
	close(): void;
}>;

export function startPhysicalAgentViewSurface(
	view: DurableAgentView,
	options: Readonly<{
		ownerTui: TUI;
		requestShutdown(): void;
		physicalTerminal?: PhysicalTerminalPort;
	}>,
): PhysicalAgentViewSurface | undefined {
	const physicalTerminal = options.physicalTerminal
		?? createProcessPhysicalTerminalPort(options.ownerTui);
	if (!physicalTerminal.supportsPhysicalAttachment) return undefined;
	let closed = false;
	let settleClosed!: () => void;
	const closedPromise = new Promise<void>((resolve) => {
		settleClosed = resolve;
	});
	const closeFromHost = () => {
		if (closed) return;
		closed = true;
		attachment.close();
		settleClosed();
	};
	const failFromAttachment = (error: unknown) => {
		if (closed) return;
		try {
			view.fail(error);
		} finally {
			closeFromHost();
		}
	};
	const attachment = new PhysicalTerminalAttachment({
		ownerTui: options.ownerTui,
		physicalTerminal,
		fail: failFromAttachment,
		requestExit() {
			closeFromHost();
			options.requestShutdown();
		},
	});
	const attachCurrentProjection = () => {
		if (closed) return;
		void attachment.attach(view.projection()).catch(failFromAttachment);
	};
	const removeViewChangeHandler = view.addChangeHandler(attachCurrentProjection);
	const removeViewCloseHandler = view.addCloseHandler(closeFromHost);
	const ready = attachment.attach(view.projection()).catch(failFromAttachment);
	const cleanup = closedPromise.then(async () => {
		removeViewChangeHandler();
		removeViewCloseHandler();
		attachment.close();
		await view.close();
	});
	return {
		ready,
		closed: cleanup,
		suspend: () => attachment.suspend(),
		resume: () => attachment.attach(view.projection()),
		close: closeFromHost,
	};
}

export type DurableAgentView = Readonly<{
	agentId: string;
	label: string;
	projection(): TerminalProjection;
	addChangeHandler(handler: () => void): () => void;
	addCloseHandler(handler: () => void): () => void;
	fail(error: unknown): void;
	close(): Promise<void>;
}>;

export async function openAgentViewSurface(
	ui: ExtensionUIContext,
	view: DurableAgentView,
	options: Readonly<{
		requestShutdown(): void;
		physicalTerminal?: PhysicalTerminalPort;
	}> = {
		requestShutdown: () => undefined,
	},
): Promise<void> {
	let attachment: AgentTerminalAttachment | undefined;
	let handle: OverlayHandle | undefined;
	let closedByHost = false;
	let settleHostClose!: () => void;
	const hostClose = new Promise<void>((resolve) => {
		settleHostClose = resolve;
	});
	let removeViewChangeHandler: () => void = () => undefined;
	let removeViewCloseHandler: () => void = () => undefined;

	const closeFromHost = () => {
		if (closedByHost) return;
		closedByHost = true;
		attachment?.close();
		handle?.hide();
		settleHostClose();
	};
	const failFromAttachment = (error: unknown) => {
		if (closedByHost) return;
		try {
			view.fail(error);
		} finally {
			closeFromHost();
		}
	};
	const attachCurrentProjection = () => {
		if (!attachment || closedByHost) return;
		void attachment.attach(view.projection()).catch(failFromAttachment);
	};

	try {
		const interactiveClose = ui.custom<void>(
			(tui) => {
				const physicalTerminal = options.physicalTerminal
					?? createProcessPhysicalTerminalPort(tui);
				const requestExit = () => {
					closeFromHost();
					options.requestShutdown();
				};
				attachment = physicalTerminal.supportsPhysicalAttachment
					? new PhysicalTerminalAttachment({
						ownerTui: tui,
						physicalTerminal,
						fail: failFromAttachment,
						requestExit,
					})
					: new DetachedDiagnosticAttachment({
						fail: failFromAttachment,
						requestExit,
					});
				removeViewChangeHandler = view.addChangeHandler(attachCurrentProjection);
				removeViewCloseHandler = view.addCloseHandler(closeFromHost);
				return new DetachedAgentDiagnosticSurface(
					view,
					(data) => attachment?.dispatchInput(data),
				);
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
				onHandle: (overlayHandle) => {
					handle = overlayHandle;
					if (closedByHost) {
						overlayHandle.hide();
						return;
					}
					attachCurrentProjection();
				},
			},
		);
		await Promise.race([interactiveClose, hostClose]);
	} finally {
		removeViewChangeHandler();
		removeViewCloseHandler();
		attachment?.close();
		await view.close();
	}
}

class DetachedDiagnosticAttachment implements AgentTerminalAttachment {
	readonly #fail: (error: unknown) => void;
	readonly #requestExit: () => void;
	#projection: TerminalProjection | undefined;
	#removeFailureHandler: () => void = () => undefined;
	#removeExitHandler: () => void = () => undefined;
	#closed = false;

	constructor(options: {
		fail(error: unknown): void;
		requestExit(): void;
	}) {
		this.#fail = options.fail;
		this.#requestExit = options.requestExit;
	}

	async attach(projection: TerminalProjection): Promise<void> {
		if (this.#closed || this.#projection === projection) return;
		this.#releaseProjection();
		if (this.#closed) return;
		this.#projection = projection;
		const removeFailureHandler = projection.addFailureHandler((error) => {
			if (this.#projection !== projection || this.#closed) return;
			this.#fail(error);
		});
		if (this.#closed || this.#projection !== projection) {
			removeFailureHandler();
			return;
		}
		this.#removeFailureHandler = removeFailureHandler;
		const removeExitHandler = projection.addExitRequestHandler(() => {
			if (this.#projection !== projection || this.#closed) return;
			this.close();
			this.#requestExit();
		});
		if (this.#closed || this.#projection !== projection) {
			removeExitHandler();
			return;
		}
		this.#removeExitHandler = removeExitHandler;
	}

	dispatchInput(data: string): void {
		if (this.#closed || !this.#projection) return;
		try {
			this.#projection.dispatchInput(data);
		} catch (error) {
			this.#fail(error);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#releaseProjection();
	}

	#releaseProjection(): void {
		this.#projection = undefined;
		this.#removeFailureHandler();
		this.#removeExitHandler();
		this.#removeFailureHandler = () => undefined;
		this.#removeExitHandler = () => undefined;
	}
}

/**
 * Non-terminal SDK/test hosts keep xterm as their terminal and use this surface
 * only for diagnostics. Interactive Pi never uses it as the live child renderer.
 */
class DetachedAgentDiagnosticSurface implements Component {
	readonly #view: DurableAgentView;
	readonly #dispatchInput: (data: string) => void;

	constructor(
		view: DurableAgentView,
		dispatchInput: (data: string) => void,
	) {
		this.#view = view;
		this.#dispatchInput = dispatchInput;
	}

	render(width: number): string[] {
		return this.#view.projection().presentation.render(width);
	}

	handleInput(data: string): void {
		this.#dispatchInput(data);
	}

	invalidate(): void {
		this.#view.projection().presentation.invalidate();
	}
}
