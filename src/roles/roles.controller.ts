import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { RolesService } from './roles.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AssignRoleSchema, type AssignRoleDto } from './dto/assign-role.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

@Controller()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('roles')
  @RequirePermission('role:read')
  listRoles() {
    return this.rolesService.listRoles();
  }

  @Post('users/:id/roles')
  @RequirePermission('role:assign')
  assignRole(
    @Param('id') userId: string,
    @Body(new ZodValidationPipe(AssignRoleSchema)) dto: AssignRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.rolesService.assignRole(userId, dto.roleId, actor.userId);
  }

  @Delete('users/:id/roles/:roleId')
  @RequirePermission('role:revoke')
  revokeRole(
    @Param('id') userId: string,
    @Param('roleId') roleId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.rolesService.revokeRole(userId, roleId, actor.userId);
  }
}
