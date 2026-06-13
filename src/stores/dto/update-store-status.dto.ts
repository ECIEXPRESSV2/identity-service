import { z } from 'zod';

export const UpdateStoreStatusSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']),
  reason: z.string().max(200).optional(),
});

export type UpdateStoreStatusDto = z.infer<typeof UpdateStoreStatusSchema>;
