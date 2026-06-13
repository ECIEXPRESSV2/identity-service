import { z } from 'zod';

export const AssignRoleSchema = z.object({
  roleId: z.string().uuid(),
});

export type AssignRoleDto = z.infer<typeof AssignRoleSchema>;
