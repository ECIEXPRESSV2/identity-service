import { z } from 'zod';

export const CreateStoreSchema = z.object({
  name:        z.string().min(2).max(120),
  type:        z.enum(['CAFETERIA', 'PAPELERIA', 'RESTAURANTE']),
  description: z.string().max(500).optional(),
  location:    z.string().min(2).max(200),
  imageUrl:    z.string().url().optional(),
});

export type CreateStoreDto = z.infer<typeof CreateStoreSchema>;
