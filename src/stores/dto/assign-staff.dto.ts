import { z } from 'zod';

export const AssignStaffSchema = z.object({
  userId: z.string().uuid(),
});

export type AssignStaffDto = z.infer<typeof AssignStaffSchema>;
