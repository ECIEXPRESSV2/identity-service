import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
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
    roles:  [{ id: 'rol-uuid', name: 'VENDOR' }],
  },
};

@ApiTags('Roles')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post('roles')
  @RequirePermission('role:write')
  @ApiOperation({
    summary: 'Crear rol personalizado',
    description: 'Crea un nuevo rol no-sistema. Requiere permiso `role:write`.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name:        { type: 'string', minLength: 2, maxLength: 50, example: 'SUPERVISOR' },
        description: { type: 'string', maxLength: 200, example: 'Supervisor de tienda' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Rol creado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `role:write` requerido' })
  @ApiResponse({ status: 409, description: 'Ya existe un rol con ese nombre' })
  createRole(
    @Body('name')        name: string,
    @Body('description') description?: string,
    @CurrentUser()       actor?: AuthenticatedUser,
  ) {
    return this.rolesService.createRole(name, description, actor?.userId);
  }

  @Get('permissions')
  @RequirePermission('role:read')
  @ApiOperation({
    summary: 'Listar permisos disponibles',
    description: 'Retorna los permisos del sistema. Filtrable por `resource`. Requiere permiso `role:read`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de permisos',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:          { type: 'string', format: 'uuid' },
          resource:    { type: 'string', example: 'store' },
          action:      { type: 'string', example: 'write' },
          description: { type: 'string', nullable: true },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `role:read` requerido' })
  listPermissions(@Query('resource') resource?: string) {
    return this.rolesService.listPermissions(resource);
  }

  @Put('roles/:roleId/permissions')
  @RequirePermission('role:write')
  @ApiOperation({
    summary: 'Reemplazar permisos de un rol',
    description:
      'Reemplaza completamente la lista de permisos del rol. Es idempotente. ' +
      'No aplica a roles de sistema. Requiere permiso `role:write`.',
  })
  @ApiParam({ name: 'roleId', description: 'UUID del rol', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['permissionIds'],
      properties: {
        permissionIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          example: ['perm-uuid-1', 'perm-uuid-2'],
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Permisos actualizados' })
  @ApiResponse({ status: 400, description: 'Uno o más permissionIds no existen' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `role:write` requerido' })
  @ApiResponse({ status: 404, description: 'Rol no encontrado' })
  @ApiResponse({ status: 422, description: 'El rol es de sistema y no puede modificarse' })
  setRolePermissions(
    @Param('roleId')         roleId: string,
    @Body('permissionIds')   permissionIds: string[],
    @CurrentUser()           actor: AuthenticatedUser,
  ) {
    return this.rolesService.setRolePermissions(roleId, permissionIds ?? [], actor.userId, actor.correlationId);
  }

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
        { id: 'uuid-2', name: 'VENDOR',   description: 'Vendedor',      isSystem: true },
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
    return this.rolesService.assignRole(userId, dto.roleId, actor.userId, actor.correlationId);
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
    return this.rolesService.revokeRole(userId, roleId, actor.userId, actor.correlationId);
  }
}
