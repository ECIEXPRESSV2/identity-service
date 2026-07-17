import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PqrsStatus } from '@prisma/client';
import { PqrsService } from './pqrs.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CreatePqrsSchema, type CreatePqrsDto } from './dto/create-pqrs.dto';
import { AddPqrsMessageSchema, type AddPqrsMessageDto } from './dto/add-pqrs-message.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

const isAdmin = (user: AuthenticatedUser) => user.roles.includes('ADMIN');

@ApiTags('PQRS')
@ApiBearerAuth()
@Controller('pqrs')
export class PqrsController {
  constructor(private readonly pqrsService: PqrsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear una PQRS (petición, queja, reclamo o sugerencia).' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreatePqrsSchema)) dto: CreatePqrsDto,
  ) {
    return this.pqrsService.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar PQRS.',
    description: 'Un administrador ve todas (con filtro opcional `status`); cualquier otro usuario ve solo las suyas.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: string) {
    if (isAdmin(user)) {
      const parsed = this.parseStatus(status);
      return this.pqrsService.listAll(parsed);
    }
    return this.pqrsService.listMine(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver el hilo completo de una PQRS (dueño o administrador).' })
  getThread(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.pqrsService.getThread(id, user.userId, isAdmin(user));
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Responder una PQRS (dueño o administrador; solo si sigue abierta).' })
  addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddPqrsMessageSchema)) dto: AddPqrsMessageDto,
  ) {
    return this.pqrsService.addMessage(id, user.userId, isAdmin(user), dto);
  }

  @Patch(':id/close')
  @RequirePermission('pqrs:manage')
  @ApiOperation({ summary: 'Cerrar una PQRS (solo administrador).' })
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.pqrsService.close(id, user.userId);
  }

  private parseStatus(raw?: string): PqrsStatus | undefined {
    if (!raw) return undefined;
    const upper = raw.toUpperCase();
    if (upper !== 'OPEN' && upper !== 'CLOSED') {
      throw new BadRequestException('status debe ser OPEN o CLOSED');
    }
    return upper as PqrsStatus;
  }
}
