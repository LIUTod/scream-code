/**
 * One-call helper for declaring a user tool with zod parameters.
 *
 * The low-level path (`ToolManager.registerUserTool`) takes a hand-written
 * JSON-Schema `parameters` object. This helper derives that schema from a zod
 * schema using the same input-view / closed-object rules the built-in tools
 * use (`toInputJsonSchema`), so a new user tool is five lines instead of
 * twenty: name, description, a zod object, and one call.
 *
 * The returned registration plugs straight into `ToolManager.registerUserTool`.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '../../tools/support/input-schema';
import type { UserToolRegistration } from './types';

export interface DefineUserToolInput {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType;
}

export function defineUserTool(input: DefineUserToolInput): UserToolRegistration {
  return {
    name: input.name,
    description: input.description,
    parameters: toInputJsonSchema(input.parameters),
  };
}
