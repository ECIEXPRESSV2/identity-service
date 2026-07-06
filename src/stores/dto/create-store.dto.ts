import { z } from 'zod';

// El logo se envía como archivo (multipart) en la misma petición de creación, no como URL.
// Los campos de texto llegan por multipart, por eso `description` se deja opcional/vacío-tolerante.
export const CreateStoreSchema = z.object({
  name:        z.string().min(2).max(120),
  type:        z.enum(['CAFETERIA', 'PAPELERIA', 'RESTAURANTE']),
  description: z.string().max(500).optional(),
  location:    z.string().min(2).max(200),
});

export type CreateStoreDto = z.infer<typeof CreateStoreSchema>;
