import { z } from 'zod';

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CreateScheduleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().regex(timeRegex, 'Must be HH:MM'),
  closeTime: z.string().regex(timeRegex, 'Must be HH:MM'),
  isActive: z.boolean().default(true),
});

export type CreateScheduleDto = z.infer<typeof CreateScheduleSchema>;
