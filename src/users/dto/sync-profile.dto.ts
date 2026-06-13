import { z } from 'zod';

export const SyncProfileSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().max(20).optional(),
});

export type SyncProfileDto = z.infer<typeof SyncProfileSchema>;
