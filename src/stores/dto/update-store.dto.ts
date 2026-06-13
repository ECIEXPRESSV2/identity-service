import { z } from 'zod';

export const UpdateStoreSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  location: z.string().min(2).max(200).optional(),
  imageUrl: z.string().url().optional(),
});

export type UpdateStoreDto = z.infer<typeof UpdateStoreSchema>;
