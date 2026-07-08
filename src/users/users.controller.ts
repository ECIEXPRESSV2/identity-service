import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { ProfileAssetsService } from './profile-assets.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SyncProfileSchema, type SyncProfileDto } from './dto/sync-profile.dto';
import { UpdatePhoneSchema, type UpdatePhoneDto } from './dto/update-phone.dto';
import { UpdateProfileSchema, type UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateStatusSchema, type UpdateStatusDto } from './dto/update-status.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';
import { UserStatus } from '@prisma/client';
import { SessionService } from '../common/services/session.service';
import { SkipSessionValidation } from '../common/decorators/skip-session.decorator';

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

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
  constructor(
    private readonly usersService: UsersService,
    private readonly sessionService: SessionService,
    private readonly profileAssets: ProfileAssetsService,
  ) {}

  @Post('auth/sync-profile')
  @SkipSessionValidation()
  @ApiOperation({
    summary: 'Registrar o sincronizar perfil de usuario',
    description:
      'Crea el perfil local en PostgreSQL vinculado al Firebase UID del token. ' +
      'Si el perfil ya existe es idempotente: retorna el perfil existente sin crear duplicados. ' +
      'Debe llamarse en el primer login exitoso desde el cliente. ' +
      'Asigna el rol **BUYER** por defecto y publica el evento `UserRegistered` al bus. ' +
      'Retorna un `sessionId` que el cliente debe guardar en `sessionStorage` y enviar ' +
      'como header `X-Session-Id` en todas las peticiones posteriores.',
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
  @ApiResponse({
    status: 201,
    description: 'Perfil creado exitosamente',
    schema: {
      allOf: [{ type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } } }],
    },
  })
  @ApiResponse({ status: 200, description: 'Perfil ya existente — retornado sin cambios' })
  @ApiResponse({ status: 400, description: 'Validación fallida — fullName es obligatorio' })
  @ApiResponse({ status: 401, description: 'Token de Firebase ausente, expirado o inválido' })
  async syncProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(SyncProfileSchema)) dto: SyncProfileDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, ...profile } = await this.usersService.syncProfile(
      user.firebaseUid,
      user.email,
      dto,
      user.correlationId,
    );
    const sessionId = await this.sessionService.createSession(profile.id);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return { ...profile, sessionId };
  }

  @Get('users')
  @RequirePermission('user:read')
  @ApiOperation({
    summary: 'Listar usuarios',
    description: 'Lista paginada de usuarios con filtros opcionales. Requiere permiso `user:read`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de usuarios',
    schema: {
      type: 'object',
      properties: {
        data:  { type: 'array', items: USER_SCHEMA },
        meta: {
          type: 'object',
          properties: {
            total:      { type: 'number' },
            page:       { type: 'number' },
            limit:      { type: 'number' },
            totalPages: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `user:read` requerido' })
  async listUsers(
    @Query('page')   page   = '1',
    @Query('limit')  limit  = '20',
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('role')   role?:   string,
    @Query('sortBy') sortBy?: string,
  ) {
    const result = await this.usersService.listUsers(
      { search, status: status as UserStatus | undefined, role, sortBy: sortBy as 'createdAt' | 'lastLoginAt' | undefined },
      Math.max(1, Number.parseInt(page, 10) || 1),
      Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20)),
    );
    return {
      ...result,
      data: result.data.map((u) => ({ ...u, avatarUrl: this.profileAssets.signUrl(u.avatarUrl) })),
    };
  }

  @Get('users/me')
  @ApiOperation({
    summary: 'Obtener perfil propio',
    description: 'Retorna el perfil del usuario autenticado incluyendo sus roles activos.',
  })
  @ApiResponse({ status: 200, description: 'Perfil del usuario autenticado', schema: USER_SCHEMA })
  @ApiResponse({ status: 401, description: 'Token inválido o usuario sin perfil — ejecutar sync-profile' })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    const u = await this.usersService.findByFirebaseUid(user.firebaseUid);
    return { ...u, avatarUrl: this.profileAssets.signUrl(u.avatarUrl) };
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
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
  ) {
    if (dto.avatarUrl) {
      dto.avatarUrl = dto.avatarUrl.split('?')[0];
    }
    const u = await this.usersService.updateProfile(user.userId, dto, user.correlationId);
    return { ...u, avatarUrl: this.profileAssets.signUrl(u.avatarUrl) };
  }

  @Patch('users/me/phone')
  @ApiOperation({
    summary: 'Actualizar celular propio',
    description:
      'Actualiza unicamente el numero de celular del usuario autenticado. ' +
      'Publica el evento `UserProfileUpdated` con el campo `phone` modificado.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone'],
      properties: {
        phone: {
          type: 'string',
          minLength: 7,
          maxLength: 20,
          example: '+57 300 123 4567',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Celular actualizado', schema: USER_SCHEMA })
  @ApiResponse({ status: 400, description: 'Validacion fallida' })
  @ApiResponse({ status: 401, description: 'Token invalido' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  updateMyPhone(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdatePhoneSchema)) dto: UpdatePhoneDto,
  ) {
    return this.usersService.updatePhone(user.userId, dto.phone, user.correlationId);
  }

  @Post('users/me/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Subir/actualizar foto de perfil',
    description:
      'Recibe la imagen (campo `file`, multipart), la sube a Azure Blob Storage como ' +
      '`profiles/<userId>/avatar.<ext>` y persiste la URL pública en `avatarUrl`. ' +
      'Máx. 5 MB; PNG, JPEG o WebP.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'Foto de perfil' } },
    },
  })
  @ApiResponse({ status: 200, description: 'Foto de perfil actualizada', schema: USER_SCHEMA })
  @ApiResponse({ status: 400, description: 'Archivo faltante o tipo/tamaño inválido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 503, description: 'Almacenamiento de imágenes no configurado' })
  async uploadAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    if (!file) throw new BadRequestException('Debes adjuntar una imagen en el campo "file"');
    const blobUrl = await this.profileAssets.uploadProfilePhoto(
      user.userId,
      file.buffer,
      file.mimetype,
    );
    const u = await this.usersService.updateProfile(user.userId, { avatarUrl: blobUrl }, user.correlationId);
    return { ...u, avatarUrl: this.profileAssets.signUrl(blobUrl) };
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
  async getUser(@Param('id') id: string) {
    const u = await this.usersService.findById(id);
    return { ...u, avatarUrl: this.profileAssets.signUrl(u.avatarUrl) };
  }

  @Patch('users/bulk/status')
  @RequirePermission('user:deactivate')
  @ApiOperation({
    summary: 'Cambiar estado de múltiples usuarios',
    description: 'Actualiza el estado de varios usuarios en una sola operación. Requiere permiso `user:deactivate`.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userIds', 'status'],
      properties: {
        userIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
        status:  { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] },
        reason:  { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Estados actualizados' })
  @ApiResponse({ status: 400, description: 'userIds vacío o status inválido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `user:deactivate` requerido' })
  async bulkUpdateStatus(
    @Body('userIds') userIds: string[],
    @Body('status')  status: string,
    @Body('reason')  reason: string | undefined,
    @CurrentUser()   actor: AuthenticatedUser,
  ) {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new BadRequestException('userIds debe ser un array no vacío');
    }
    const validStatuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(`status debe ser uno de: ${validStatuses.join(', ')}`);
    }
    const result = await this.usersService.bulkUpdateStatus(
      userIds,
      status as UserStatus,
      actor.userId,
      actor.correlationId,
      reason,
    );
    return {
      ...result,
      users: result.users.map((u) => ({ ...u, avatarUrl: this.profileAssets.signUrl(u.avatarUrl) })),
    };
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
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Justificacion administrativa del cambio de estado',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Estado actualizado', schema: USER_SCHEMA })
  @ApiResponse({ status: 400, description: 'Status inválido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `user:deactivate` requerido' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  async updateStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateStatusSchema)) dto: UpdateStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const u = await this.usersService.updateStatus(
      id,
      dto.status as UserStatus,
      actor.userId,
      actor.correlationId,
      dto.reason,
    );
    return { ...u, avatarUrl: this.profileAssets.signUrl(u.avatarUrl) };
  }
}
