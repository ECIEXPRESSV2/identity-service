import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { AuditService } from './audit.service';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermission('audit:read')
  @ApiOperation({
    summary: 'Consultar log de auditoría',
    description:
      'Retorna registros de auditoría paginados y filtrados. ' +
      'Requiere permiso `audit:read` (solo ADMIN).',
  })
  @ApiResponse({
    status: 200,
    description: 'Logs de auditoría paginados',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id:         { type: 'string', format: 'uuid' },
              actorId:    { type: 'string', nullable: true },
              targetId:   { type: 'string' },
              targetType: { type: 'string' },
              action:     { type: 'string' },
              oldValue:   { type: 'object', nullable: true },
              newValue:   { type: 'object', nullable: true },
              ipAddress:  { type: 'string', nullable: true },
              createdAt:  { type: 'string', format: 'date-time' },
            },
          },
        },
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
  @ApiResponse({ status: 400, description: 'Rango de fechas inválido o acción desconocida' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `audit:read` requerido' })
  listAuditLogs(
    @Query('page')       page       = '1',
    @Query('limit')      limit      = '20',
    @Query('actorId')    actorId?:    string,
    @Query('targetId')   targetId?:   string,
    @Query('targetType') targetType?: string,
    @Query('action')     action?:     string,
    @Query('from')       from?:       string,
    @Query('to')         to?:         string,
  ) {
    const parsedFrom = from ? new Date(from) : undefined;
    const parsedTo   = to   ? new Date(to)   : undefined;

    if (parsedFrom && isNaN(parsedFrom.getTime())) throw new BadRequestException('from debe ser una fecha ISO válida');
    if (parsedTo   && isNaN(parsedTo.getTime()))   throw new BadRequestException('to debe ser una fecha ISO válida');
    if (parsedFrom && parsedTo && parsedFrom > parsedTo) throw new BadRequestException('from debe ser anterior a to');

    const validAction = action && Object.values(AuditAction).includes(action as AuditAction)
      ? (action as AuditAction)
      : undefined;

    if (action && !validAction) throw new BadRequestException(`Acción inválida: ${action}`);

    return this.auditService.listAuditLogs(
      { actorId, targetId, targetType, action: validAction, from: parsedFrom, to: parsedTo },
      Math.max(1, Number.parseInt(page, 10) || 1),
      Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20)),
    );
  }
}
