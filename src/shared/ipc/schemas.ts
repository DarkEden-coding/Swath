import { z } from "zod";

export const shellProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

export const ptyResizeRequestSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number(),
});

export const terminalSessionStartRequestSchema = ptyResizeRequestSchema.extend({
  cwd: z.string(),
  shellProfile: shellProfileSchema.nullish(),
  env: z.record(z.string(), z.string()).optional(),
  metadata: z.unknown().optional(),
});

export const terminalSessionAttachRequestSchema = terminalSessionStartRequestSchema.extend({
  replay: z.boolean().optional(),
});

export const appConfigSchema = z
  .object({
    version: z.literal(2),
    workspaces: z.array(z.unknown()),
    activeWorkspaceId: z.string().nullable(),
    settings: z.unknown(),
  })
  .passthrough();
