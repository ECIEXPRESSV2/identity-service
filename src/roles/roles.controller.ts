import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AssignRoleSchema, type AssignRoleDto } from './dto/assign-role.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

const ROLE_ASSIGNMENT_SCHEMA = {
  type: 'object',
  properties: {
    userId: { type: 'string', format: 'uuid' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:   { type: 'string', format: 'uuid' },
          name: { type: 'string' },
        },
      },
    },
  },
  example: {
    userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    roles:  [{ id: 'rol-uuid', name: 'SELLER' }],
  },
};

@ApiTags('Roles')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('roles')
  @RequirePermission('role:read')
  @ApiOperation({
    summary: 'Listar todos los roles del sistema',
    description: 'Retorna los roles disponibles para asignar. Requiere permiso `role:read`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de roles',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:          { type: 'string', format: 'uuid' },
          name:        { type: 'string' },
          description: { type: 'string', nullable: true },
          isSystem:    { type: 'boolean' },
        },
      },
      example: [
        { id: 'uuid-1', name: 'BUYER',    description: 'Comprador',     isSystem: true },
        { id: 'uuid-2', name: 'SELLER',   description: 'Vendedor',      isSystem: true },
        { id: 'uuid-3', name: 'ADMIN',    description: 'Administrador', isSystem: true },
        { id: 'uuid-4', name: 'ANALYST',  description: 'Analista',      isSystem: true },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `role:read` requerido' })
  listRoles() {
    return this.rolesService.listRoles();
  }

  @Post('users/:id/roles')
  @RequirePermission('role:assign')
  @ApiOperation({
    summary: 'Asignar rol a un usuario',
    description:
      'Asigna un rol existente al usuario indicado. ' +
      'Es idempotente: si el usuario ya tiene el rol, retorna 200 sin duplicar. ' +
      'Requiere permiso `role:assign` (solo ADMINs). ' +
      'Invalida la caché de permisos del usuario afectado.',
  })
  @ApiParam({ name: 'id', description: 'UUID del usuario al que se asigna el rol', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['roleId'],
      properties: {
        roleId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID del rol a asignar (obtener con GET /roles)',
          example: 'rol-uuid-aqui',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Rol asignado (o ya existía)', schema: ROLE_ASSIGNMENT_SCHEMA })
  @ApiResponse({ status: 400, description: 'roleId inválido o faltante' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `role:assign` requerido' })
  @ApiResponse({ status: 404, description: 'Usuario o rol no encontrado' })
  assignRole(
    @Param('id') userId: string,
    @Body(new ZodValidationPipe(AssignRoleSchema)) dto: AssignRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.rolesService.assignRole(userId, dto.roleId, actor.userId);
  }

  @Delete('users/:id/roles/:roleId')
  @RequirePermission('role:revoke')
  @ApiOperation({
    summary: 'Revocar rol de un usuario',
    description:
      'Elimina un rol asignado al usuario. ' +
      'No permite revocar el último rol activo del usuario. ' +
      'Requiere permiso `role:revoke` (solo ADMINs). ' +
      'Invalida la caché de permisos del usuario afectado.',
  })
  @ApiParam({ name: 'id',     description: 'UUID del usuario', format: 'uuid' })
  @ApiParam({ name: 'roleId', description: 'UUID del rol a revocar', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Rol revocado', schema: ROLE_ASSIGNMENT_SCHEMA })
  @ApiResponse({ status: 400, description: 'No se puede revocar el último rol del usuario' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `role:revoke` requerido' })
  @ApiResponse({ status: 404, description: 'Usuario, rol o asignación no encontrada' })
  revokeRole(
    @Param('id') userId: string,
    @Param('roleId') roleId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.rolesService.revokeRole(userId, roleId, actor.userId);
  }
}
