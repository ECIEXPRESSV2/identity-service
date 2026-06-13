import { z } from 'zod';

export const UpdateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
});

export type UpdateStatusDto = z.infer<typeof UpdateStatusSchema>;
