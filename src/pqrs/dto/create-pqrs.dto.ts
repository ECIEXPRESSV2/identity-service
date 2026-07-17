import { z } from 'zod';

export const CreatePqrsSchema = z.object({
  subject: z.string().trim().min(3).max(150),
  body: z.string().trim().min(1).max(5000),
});

export type CreatePqrsDto = z.infer<typeof CreatePqrsSchema>;
