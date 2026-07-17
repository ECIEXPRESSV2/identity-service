import { z } from 'zod';

export const AddPqrsMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

export type AddPqrsMessageDto = z.infer<typeof AddPqrsMessageSchema>;
