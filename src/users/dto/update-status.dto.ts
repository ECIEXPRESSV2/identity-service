import { z } from 'zod';

export const UpdateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type UpdateStatusDto = z.infer<typeof UpdateStatusSchema>;
