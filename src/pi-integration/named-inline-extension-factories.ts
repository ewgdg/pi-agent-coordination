import type {
	ExtensionFactory,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type UnknownRecord = Record<PropertyKey, unknown>;

export type NamedInlineExtension = Readonly<{
	name: string;
	factory: ExtensionFactory;
	hidden?: boolean;
}>;

export type ResolvedRunExtensions = Readonly<{
	filePaths: readonly string[];
	inlineFactories: readonly NamedInlineExtension[];
}>;

export class InlineExtensionInheritanceError extends Error {
	readonly reference: string;

	constructor(reference: string, reason: string) {
		super(`Cannot inherit inline extension ${reference}: ${reason}`);
		this.name = "InlineExtensionInheritanceError";
		this.reference = reference;
	}
}

export function assertInlineExtensionFactoryRegistryShape(
	resourceLoader: unknown,
	memberName: string,
	incompatible: (memberName: string) => never,
): void {
	readInlineExtensionFactories(resourceLoader, memberName, incompatible);
}

export async function loadPiBuiltInExtensionFactories(): Promise<readonly InlineExtension[]> {
	// Pi's public SDK does not export its CLI built-ins. Resolve the installed CLI
	// module here so conformance tests exercise the same registry that real hosts use.
	const modulePath = join(getPackageDir(), "dist", "extensions", "index.js");
	const moduleValue: unknown = await import(pathToFileURL(modulePath).href);
	if (!isRecord(moduleValue) || !("builtInExtensions" in moduleValue)) {
		throw new Error("Incompatible Pi host: PiBuiltInExtensions.builtInExtensions");
	}
	return readInlineExtensionFactories(
		{ extensionFactories: moduleValue.builtInExtensions },
		"PiBuiltInExtensions.builtInExtensions",
		(memberName) => {
			throw new Error(`Incompatible Pi host: ${memberName}`);
		},
	);
}

export function resolveRunExtensions(
	resourceLoader: unknown,
	references: readonly string[],
): ResolvedRunExtensions {
	const registry = readInlineExtensionFactories(
		resourceLoader,
		"AgentSessionRuntime.services.resourceLoader.extensionFactories",
		(memberName) => {
			throw new Error(`Incompatible Pi host during Agent Run preparation: ${memberName}`);
		},
	);
	const candidatesByReference = new Map<string, RegistryCandidate[]>();
	for (const [index, extension] of registry.entries()) {
		const candidate = typeof extension === "function"
			? {
				kind: "anonymous" as const,
				reference: `<inline:${index + 1}>`,
			}
			: {
				kind: "named" as const,
				reference: `<inline:${extension.name}>`,
				descriptor: cloneNamedDescriptor(extension),
			};
		const candidates = candidatesByReference.get(candidate.reference) ?? [];
		candidates.push(candidate);
		candidatesByReference.set(candidate.reference, candidates);
	}

	const filePaths: string[] = [];
	const inlineFactories: NamedInlineExtension[] = [];
	for (const reference of references) {
		if (!reference.startsWith("<inline:")) {
			filePaths.push(reference);
			continue;
		}
		const candidates = candidatesByReference.get(reference);
		if (!candidates || candidates.length === 0) {
			throw new InlineExtensionInheritanceError(
				reference,
				"the current Pi host has no matching named factory",
			);
		}
		if (candidates.some(({ kind }) => kind === "anonymous")) {
			throw new InlineExtensionInheritanceError(
				reference,
				"anonymous positional factories are not durable",
			);
		}
		if (candidates.length !== 1) {
			throw new InlineExtensionInheritanceError(
				reference,
				"the current Pi host has duplicate named factories",
			);
		}
		const candidate = candidates[0];
		if (candidate?.kind !== "named") {
			throw new Error("Inline extension candidate narrowing failed");
		}
		inlineFactories.push(candidate.descriptor);
	}
	return { filePaths, inlineFactories };
}

type RegistryCandidate =
	| Readonly<{
		kind: "anonymous";
		reference: string;
	}>
	| Readonly<{
		kind: "named";
		reference: string;
		descriptor: NamedInlineExtension;
	}>;

function readInlineExtensionFactories(
	resourceLoader: unknown,
	memberName: string,
	incompatible: (memberName: string) => never,
): readonly InlineExtension[] {
	if (!isRecord(resourceLoader)) incompatible(memberName);
	if (!("extensionFactories" in resourceLoader)) incompatible(memberName);
	const factories = resourceLoader.extensionFactories;
	if (!Array.isArray(factories)) incompatible(memberName);
	for (let index = 0; index < factories.length; index += 1) {
		const entryName = `${memberName}[${index}]`;
		if (!(index in factories)) incompatible(entryName);
		const entry = factories[index];
		if (typeof entry === "function") continue;
		if (!isRecord(entry) || Array.isArray(entry)) incompatible(entryName);
		if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
			incompatible(`${entryName}.name`);
		}
		if (typeof entry.factory !== "function") incompatible(`${entryName}.factory`);
		if (entry.hidden !== undefined && typeof entry.hidden !== "boolean") {
			incompatible(`${entryName}.hidden`);
		}
	}
	return factories as InlineExtension[];
}

function cloneNamedDescriptor(extension: NamedInlineExtension): NamedInlineExtension {
	return {
		name: extension.name,
		factory: extension.factory,
		...(extension.hidden === undefined ? {} : { hidden: extension.hidden }),
	};
}

function isRecord(value: unknown): value is UnknownRecord {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}
