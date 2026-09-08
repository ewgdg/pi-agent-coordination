import { Type } from "typebox";
import { RUNTIME_THINKING_LEVELS } from "./runtime-configuration.ts";

export const RuntimeThinkingSchema = Type.Enum(RUNTIME_THINKING_LEVELS);
