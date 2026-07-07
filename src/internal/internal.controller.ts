import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InternalService } from './internal.service';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Internal')
@Controller('internal')
export class InternalController {
  constructor(private readonly internalService: InternalService) {}

  @Get('users/:userId/validate')
  @Public()
  @ApiOperation({
    summary: '[Interno] Validar usuario',
    description:
      'Endpoint para uso interno entre microservicios. ' +
      'Retorna existencia, estado activo, roles y rol efectivo del usuario.',
  })
  @ApiParam({ name: 'userId', description: 'UUID del usuario a validar', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Resultado de validación',
    schema: {
      type: 'object',
      properties: {
        exists:        { type: 'boolean' },
        isActive:      { type: 'boolean' },
        roles:         { type: 'array', items: { type: 'string' } },
        effectiveRole: { type: 'string', nullable: true },
        userId:        { type: 'string', nullable: true },
        email:         { type: 'string', nullable: true },
      },
      example: { exists: true, isActive: true, roles: ['VENDOR'], effectiveRole: 'VENDOR', userId: 'uuid', email: 'user@eci.edu.co' },
    },
  })
  validateUser(@Param('userId') userId: string) {
    return this.internalService.validateUser(userId);
  }

  @Get('users/by-firebase/:firebaseUid')
  @Public()
  @ApiOperation({
    summary: '[Interno] Enriquecer identidad por firebaseUid (para el API Gateway)',
    description:
      'Traduce el firebaseUid (ya extraído por el gateway de un token Firebase YA validado) ' +
      'al identificador local del usuario, sus roles y su tienda. Pensado para que el API Gateway ' +
      'inyecte x-user-id / x-user-role / x-user-store a los servicios downstream. ' +
      'NO recibe ni valida token, NO exige X-Session-Id: confía en que solo el gateway lo alcanza ' +
      'desde la red interna (mismo modelo de confianza que los demás /internal/*). ' +
      '⚠️ INTERNO-ONLY: NO debe exponerse a internet; lo protege el aislamiento de red, no un token.',
  })
  @ApiParam({
    name: 'firebaseUid',
    description: 'Firebase UID extraído del token ya validado por el gateway',
    example: 'firebase-uid-abc123',
  })
  @ApiResponse({
    status: 200,
    description: 'Identidad local enriquecida',
    schema: {
      type: 'object',
      properties: {
        userId:  { type: 'string', format: 'uuid' },
        roles:   { type: 'array', items: { type: 'string' } },
        storeId: { type: 'string', format: 'uuid', nullable: true },
        status:  { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] },
      },
      example: {
        userId:  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        roles:   ['VENDOR'],
        storeId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        status:  'ACTIVE',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'No existe un usuario local para ese firebaseUid (aún no ejecutó sync-profile)',
  })
  resolveByFirebaseUid(@Param('firebaseUid') firebaseUid: string) {
    return this.internalService.resolveByFirebaseUid(firebaseUid);
  }

  @Get('users/:userId/profile')
  @Public()
  @ApiOperation({
    summary: '[Interno] Perfil público de un usuario',
    description:
      'Endpoint para uso interno entre microservicios (Order). ' +
      'Retorna nombre y avatar de un usuario para mostrarlo en el chat comprador-vendedor, ' +
      'sin exigir el permiso `user:read` que protege `GET /users/:id`.',
  })
  @ApiParam({ name: 'userId', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Perfil público del usuario',
    schema: {
      type: 'object',
      properties: {
        fullName:  { type: 'string' },
        avatarUrl: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  getUserProfile(@Param('userId') userId: string) {
    return this.internalService.getUserProfile(userId);
  }

  @Get('stores/:storeId/staff')
  @Public()
  @ApiOperation({
    summary: '[Interno] Obtener staff de una tienda',
    description:
      'Endpoint para uso interno entre microservicios (Order, Notification). ' +
      'Retorna los usuarios activos asignados como staff de la tienda, ' +
      'para que Order pueda identificar el vendorId real del chat.',
  })
  @ApiParam({ name: 'storeId', description: 'UUID de la tienda', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Lista de staff activo de la tienda',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          userId:   { type: 'string', format: 'uuid' },
          fullName: { type: 'string' },
          email:    { type: 'string' },
          role:     { type: 'string', example: 'VENDOR' },
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  getStoreStaff(@Param('storeId') storeId: string) {
    return this.internalService.getStoreStaff(storeId);
  }

  @Get('stores/:storeId/availability')
  @Public()
  @ApiOperation({
    summary: '[Interno] Validar disponibilidad de tienda',
    description:
      'Endpoint para uso interno entre microservicios (Order, Product). ' +
      'Verifica si una tienda puede recibir pedidos en una fecha/hora dada.',
  })
  @ApiParam({ name: 'storeId', description: 'UUID de la tienda', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Disponibilidad de la tienda',
    schema: {
      type: 'object',
      properties: {
        available:     { type: 'boolean' },
        reason:        { type: 'string', nullable: true, enum: ['INACTIVE', 'TEMPORARILY_CLOSED', 'OUT_OF_SCHEDULE'] },
        endsAt:        { type: 'string', format: 'date-time', nullable: true },
        closureReason: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  checkAvailability(
    @Param('storeId') storeId: string,
    @Query('pickupAt') pickupAt?: string,
  ) {
    const date = pickupAt ? new Date(pickupAt) : undefined;
    return this.internalService.checkStoreAvailability(storeId, date);
  }
}
