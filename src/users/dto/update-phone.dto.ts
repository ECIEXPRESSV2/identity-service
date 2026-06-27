import { z } from 'zod';

export const UpdatePhoneSchema = z.object({
  phone: z
    .string()
    .trim()
    .min(7)
    .max(20)
    .regex(/^\+?[0-9\s().-]+$/, 'phone debe ser un numero de celular valido'),
});

export type UpdatePhoneDto = z.infer<typeof UpdatePhoneSchema>;
