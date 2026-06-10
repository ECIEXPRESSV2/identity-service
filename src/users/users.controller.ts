import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SyncProfileSchema, type SyncProfileDto } from './dto/sync-profile.dto';
import { UpdateProfileSchema, type UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateStatusSchema, type UpdateStatusDto } from './dto/update-status.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';
import { UserStatus } from '@prisma/client';

const USER_SCHEMA = {
  type: 'object',
  properties: {
    id:          { type: 'string', format: 'uuid' },
    firebaseUid: { type: 'string' },
    email:       { type: 'string', format: 'email' },
    fullName:    { type: 'string' },
    phone:       { type: 'string', nullable: true },
    avatarUrl:   { type: 'string', nullable: true },
    status:      { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] },
    lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt:   { type: 'string', format: 'date-time' },
    updatedAt:   { type: 'string', format: 'date-time' },
  },
  example: {
    id:          'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    firebaseUid: 'firebase-uid-abc123',
    email:       'maria.garcia@eci.edu.co',
    fullName:    'María García',
    phone:       '+57 300 123 4567',
    avatarUrl:   null,
    status:      'ACTIVE',
    lastLoginAt: null,
    createdAt:   '2026-06-10T00:57:54.338Z',
    updatedAt:   '2026-06-10T00:57:54.338Z',
  },
};

@ApiTags('Users')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('auth/sync-profile')
  @ApiOperation({
    summary: 'Registrar o sincronizar perfil de usuario',
    description:
      'Crea el perfil local en PostgreSQL vinculado al Firebase UID del token. ' +
      'Si el perfil ya existe es idempotente: retorna el perfil existente sin crear duplicados. ' +
      'Debe llamarse en el primer login exitoso desde el cliente. ' +
      'Asigna el rol **BUYER** por defecto y publica el evento `UserRegistered` al bus.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['fullName'],
      properties: {
        fullName: { type: 'string', minLength: 2, maxLength: 100, example: 'María García' },
        phone:    { type: 'string', example: '+57 300 123 4567' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Perfil creado exitosamente', schema: USER_SCHEMA })
  @ApiResponse({ status: 200, description: 'Perfil ya existente — retornado sin cambios', schema: USER_SCHEMA })
  @ApiResponse({ status: 400, description: 'Validación fallida — fullName es obligatorio' })
  @ApiResponse({ status: 401, description: 'Token de Firebase ausente, expirado o inválido' })
  syncProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(SyncProfileSchema)) dto: SyncProfileDto,
  ) {
    return this.usersService.syncProfile(
      user.firebaseUid,
      user.email,
      dto,
      user.correlationId,
    );
  }

  @Get('users/me')
  @ApiOperation({
    summary: 'Obtener perfil propio',
    description: 'Retorna el perfil del usuario autenticado incluyendo sus roles activos.',
  })
  @ApiResponse({ status: 200, description: 'Perfil del usuario autenticado', schema: USER_SCHEMA })
  @ApiResponse({ status: 401, description: 'Token inválido o usuario sin perfil — ejecutar sync-profile' })
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findByFirebaseUid(user.firebaseUid);
  }

  @Put('users/me')
  @ApiOperation({
    summary: 'Actualizar perfil propio',
    description:
      'Actualiza los campos del perfil del usuario autenticado. ' +
      'Solo se actualizan los campos enviados (patch semántico). ' +
      'Publica el evento `UserProfileUpdated` con los campos modificados.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fullName:  { type: 'string', minLength: 2, maxLength: 100, example: 'María García López' },
        phone:     { type: 'string', example: '+57 300 123 4567' },
        avatarUrl: { type: 'string', format: 'uri', example: 'https://storage.googleapis.com/avatar.jpg' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Perfil actualizado', schema: USER_SCHEMA })
  @ApiResponse({ status: 400, description: 'Validación fallida — ningún campo válido enviado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.userId, dto, user.correlationId);
  }

  @Get('users/:id')
  @RequirePermission('user:read')
  @ApiOperation({
    summary: 'Ver perfil de cualquier usuario',
    description: 'Requiere permiso `user:read`. Solo accesible por administradores.',
  })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Perfil del usuario', schema: USER_SCHEMA })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `user:read` requerido' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  getUser(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Patch('users/:id/status')
  @RequirePermission('user:deactivate')
  @ApiOperation({
    summary: 'Cambiar estado de un usuario',
    description:
      'Activa, suspende o desactiva un usuario. Requiere permiso `user:deactivate`. ' +
      'Al desactivar, publica el evento `UserDeactivated`.',
  })
  @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'],
          description: 'ACTIVE = reactivar | INACTIVE = baja | SUSPENDED = suspender temporalmente',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Estado actualizado', schema: USER_SCHEMA })
  @ApiResponse({ status: 400, description: 'Status inválido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `user:deactivate` requerido' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  updateStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateStatusSchema)) dto: UpdateStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.updateStatus(
      id,
      dto.status as UserStatus,
      actor.userId,
      actor.correlationId,
    );
  }
}
