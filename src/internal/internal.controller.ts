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
