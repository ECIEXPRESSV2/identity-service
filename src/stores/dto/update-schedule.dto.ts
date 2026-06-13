import { z } from 'zod';

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const UpdateScheduleSchema = z.object({
  openTime:  z.string().regex(timeRegex, 'Must be HH:MM').optional(),
  closeTime: z.string().regex(timeRegex, 'Must be HH:MM').optional(),
  isActive:  z.boolean().optional(),
}).refine((d) => d.openTime !== undefined || d.closeTime !== undefined || d.isActive !== undefined, {
  message: 'Al menos un campo debe enviarse',
});

export type UpdateScheduleDto = z.infer<typeof UpdateScheduleSchema>;
