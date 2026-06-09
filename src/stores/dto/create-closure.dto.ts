import { z } from 'zod';

export const CreateClosureSchema = z.object({
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  reason: z.string().max(200).optional(),
});

export type CreateClosureDto = z.infer<typeof CreateClosureSchema>;
