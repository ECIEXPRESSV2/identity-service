import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StoresService } from './stores.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { StoreType } from '@prisma/client';
import { CreateStoreSchema, type CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreSchema, type UpdateStoreDto } from './dto/update-store.dto';
import { UpdateStoreStatusSchema, type UpdateStoreStatusDto } from './dto/update-store-status.dto';
import { CreateScheduleSchema, type CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleSchema, type UpdateScheduleDto } from './dto/update-schedule.dto';
import { CreateClosureSchema, type CreateClosureDto } from './dto/create-closure.dto';
import { AssignStaffSchema, type AssignStaffDto } from './dto/assign-staff.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

// Tope de tamaño de imagen (5 MB) como red de seguridad: el frontend ya redimensiona y recomprime
// a WebP antes de subir, así que en la práctica llegan archivos mucho más pequeños. Y el tipo mínimo
// del archivo que entrega multer (memory storage), declarado localmente para no depender de @types/multer.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

const STORE_SCHEMA = {
  type: 'object',
  properties: {
    id:          { type: 'string', format: 'uuid' },
    ownerId:     { type: 'string', format: 'uuid' },
    name:        { type: 'string' },
    description: { type: 'string', nullable: true },
    location:    { type: 'string' },
    imageUrl:    { type: 'string', nullable: true },
    status:      { type: 'string', enum: ['OPEN', 'CLOSED', 'TEMPORARILY_CLOSED'] },
    isActive:    { type: 'boolean' },
    createdAt:   { type: 'string', format: 'date-time' },
    updatedAt:   { type: 'string', format: 'date-time' },
  },
  example: {
    id:          'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    ownerId:     'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name:        'Cafetería Bloque A',
    description: 'Cafetería principal del campus',
    location:    'Bloque A, piso 1',
    imageUrl:    null,
    status:      'OPEN',
    isActive:    true,
    createdAt:   '2026-06-10T01:00:00.000Z',
    updatedAt:   '2026-06-10T01:00:00.000Z',
  },
};

const SCHEDULE_SCHEMA = {
  type: 'object',
  properties: {
    id:         { type: 'string', format: 'uuid' },
    storeId:    { type: 'string', format: 'uuid' },
    dayOfWeek:  { type: 'integer', minimum: 0, maximum: 6, description: '0=Domingo … 6=Sábado' },
    openTime:   { type: 'string', example: '08:00' },
    closeTime:  { type: 'string', example: '18:00' },
    isActive:   { type: 'boolean' },
    createdAt:  { type: 'string', format: 'date-time' },
    updatedAt:  { type: 'string', format: 'date-time' },
  },
};

const CLOSURE_SCHEMA = {
  type: 'object',
  properties: {
    id:        { type: 'string', format: 'uuid' },
    storeId:   { type: 'string', format: 'uuid' },
    startDate: { type: 'string', format: 'date-time' },
    endDate:   { type: 'string', format: 'date-time' },
    reason:    { type: 'string', nullable: true },
    createdBy: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  example: {
    id:        'c3d4e5f6-a7b8-9012-cdef-123456789012',
    storeId:   'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    startDate: '2026-06-15T08:00:00.000Z',
    endDate:   '2026-06-15T18:00:00.000Z',
    reason:    'Mantenimiento programado',
    createdBy: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    createdAt: '2026-06-10T01:00:00.000Z',
  },
};

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  // ── Stores ─────────────────────────────────────────────────────────────────

  @Post()
  @RequirePermission('store:write')
  @ApiOperation({
    summary: 'Crear punto de venta',
    description:
      'Crea un nuevo punto de venta asociado al usuario autenticado como dueño. ' +
      'Requiere permiso `store:write`. ' +
      'Publica el evento `StoreCreated` al bus de mensajería.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'type', 'location'],
      properties: {
        name:        { type: 'string', minLength: 2, maxLength: 100, example: 'Cafetería Bloque A' },
        type:        { type: 'string', enum: ['CAFETERIA', 'PAPELERIA', 'RESTAURANTE'], example: 'CAFETERIA' },
        description: { type: 'string', maxLength: 500, example: 'Cafetería principal del campus' },
        location:    { type: 'string', minLength: 2, maxLength: 200, example: 'Bloque A, piso 1' },
        imageUrl:    { type: 'string', format: 'uri', example: 'https://storage.googleapis.com/img.jpg' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Tienda creada', schema: STORE_SCHEMA })
  @ApiResponse({ status: 400, description: 'Campos obligatorios faltantes o inválidos' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `store:write` requerido' })
  create(
    @Body(new ZodValidationPipe(CreateStoreSchema)) dto: CreateStoreDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.createStore(user.userId, dto, user.correlationId);
  }

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Listar tiendas activas',
    description: 'Retorna todas las tiendas activas. Endpoint público — no requiere autenticación.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de tiendas activas',
    schema: { type: 'array', items: STORE_SCHEMA },
  })
  list() {
    return this.storesService.listStores();
  }

  // ── Public / Buyer endpoints — deben ir ANTES de /:id para evitar conflictos de ruteo ──

  @Get('available')
  @Public()
  @ApiOperation({
    summary: 'Listar tiendas disponibles',
    description: 'Lista todas las tiendas activas. Filtrable por `type`. Ruta pública.',
  })
  @ApiResponse({ status: 200, description: 'Tiendas disponibles', schema: { type: 'array', items: STORE_SCHEMA } })
  listAvailable(@Query('type') type?: string) {
    return this.storesService.listAvailable(type as StoreType | undefined);
  }

  @Get('my')
  @ApiOperation({
    summary: 'Mis tiendas (vendedor)',
    description: 'Retorna las tiendas donde el usuario autenticado es dueño o staff activo.',
  })
  @ApiResponse({ status: 200, description: 'Tiendas del vendedor', schema: { type: 'array', items: STORE_SCHEMA } })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  getMyStores(@CurrentUser() user: AuthenticatedUser) {
    return this.storesService.getMyStores(user.userId);
  }

  @Get('user/:userId')
  @RequirePermission('store:read')
  @ApiOperation({
    summary: 'Tiendas de un usuario específico (admin)',
    description: 'Retorna las tiendas donde el usuario dado es dueño o staff activo. Requiere permiso `store:read`.',
  })
  @ApiParam({ name: 'userId', description: 'UUID del usuario', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Tiendas del usuario', schema: { type: 'array', items: STORE_SCHEMA } })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `store:read` requerido' })
  getStoresByUser(@Param('userId') userId: string) {
    return this.storesService.getStoresByUser(userId);
  }

  @Get(':id')
  @Public()
  @ApiOperation({
    summary: 'Ver detalle de una tienda',
    description: 'Retorna la tienda con sus horarios regulares. Endpoint público.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Detalle de la tienda con horarios',
    schema: {
      allOf: [
        STORE_SCHEMA,
        {
          properties: {
            schedules: { type: 'array', items: SCHEDULE_SCHEMA },
          },
        },
      ],
    },
  })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  findOne(@Param('id') id: string) {
    return this.storesService.findById(id);
  }

  @Put(':id')
  @RequirePermission('store:write')
  @ApiOperation({
    summary: 'Actualizar datos de una tienda',
    description:
      'Actualiza la información de la tienda. ' +
      'Solo el dueño de la tienda o un ADMIN pueden modificarla. ' +
      'No publica eventos (los cambios de estado van por PATCH /status).',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', minLength: 2, maxLength: 100 },
        description: { type: 'string', maxLength: 500 },
        location:    { type: 'string', minLength: 2, maxLength: 200 },
        imageUrl:    { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Tienda actualizada', schema: STORE_SCHEMA })
  @ApiResponse({ status: 400, description: 'Campos inválidos' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Solo el dueño o ADMIN pueden modificar esta tienda' })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateStoreSchema)) dto: UpdateStoreDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.updateStore(
      id,
      dto,
      user.userId,
      user.roles.includes('ADMIN'),
      user.correlationId,
    );
  }

  @Post(':id/logo')
  @RequirePermission('store:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Subir/actualizar el logo de una tienda',
    description:
      'Recibe la imagen (campo `file`, multipart) y la sube a Azure Blob Storage como ' +
      '`<storeId>.png`, guardando la URL pública en `imageUrl`. Máx. 5 MB; PNG, JPEG o WebP. ' +
      'Solo el dueño de la tienda o un ADMIN. Publica el evento `StoreUpdated`.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'Imagen del logo' } },
    },
  })
  @ApiResponse({ status: 200, description: 'Logo actualizado', schema: STORE_SCHEMA })
  @ApiResponse({ status: 400, description: 'Archivo faltante o tipo/tamaño inválido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Solo el dueño o ADMIN' })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  @ApiResponse({ status: 503, description: 'Almacenamiento de imágenes no configurado' })
  uploadLogo(
    @Param('id') id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException('Debes adjuntar una imagen en el campo "file"');
    return this.storesService.uploadLogo(
      id,
      file,
      user.userId,
      user.roles.includes('ADMIN'),
      user.correlationId,
    );
  }

  @Post(':id/banner')
  @RequirePermission('store:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Subir/actualizar el banner de una tienda',
    description:
      'Recibe la imagen (campo `file`, multipart) y la sube a Azure Blob Storage como ' +
      '`store-banners/<storeId>.png`. Máx. 5 MB; PNG, JPEG o WebP. El frontend lo lee por ' +
      'convención (no hay columna en BD). Solo el dueño de la tienda o un ADMIN.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'Imagen del banner' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Banner actualizado',
    schema: {
      type: 'object',
      properties: {
        storeId:   { type: 'string', format: 'uuid' },
        bannerUrl: { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Archivo faltante o tipo/tamaño inválido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Solo el dueño o ADMIN' })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  @ApiResponse({ status: 503, description: 'Almacenamiento de imágenes no configurado' })
  uploadBanner(
    @Param('id') id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException('Debes adjuntar una imagen en el campo "file"');
    return this.storesService.uploadBanner(id, file, user.userId, user.roles.includes('ADMIN'));
  }

  @Patch(':id/status')
  @RequirePermission('store:write')
  @ApiOperation({
    summary: 'Cambiar estado de una tienda',
    description:
      'Cambia el estado operativo de la tienda. ' +
      'Solo el dueño o un ADMIN pueden cambiar el estado. ' +
      'Publica el evento `StoreStatusChanged`. ' +
      '**Nota:** el estado `TEMPORARILY_CLOSED` es gestionado automáticamente por los cierres programados, no por este endpoint.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: ['OPEN', 'CLOSED'],
          description: 'Estado manual. TEMPORARILY_CLOSED es solo para cierres programados.',
        },
        reason: { type: 'string', maxLength: 200, example: 'Cierre por mantenimiento' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Estado actualizado', schema: STORE_SCHEMA })
  @ApiResponse({ status: 400, description: 'Status inválido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Solo el dueño o ADMIN' })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  patchStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateStoreStatusSchema)) dto: UpdateStoreStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.updateStatus(
      id,
      dto,
      user.userId,
      user.roles.includes('ADMIN'),
      user.correlationId,
    );
  }

  // ── Schedules ──────────────────────────────────────────────────────────────

  @Post(':id/schedules')
  @RequirePermission('store:write')
  @ApiOperation({
    summary: 'Crear o actualizar horario de un día',
    description:
      'Upsert del horario para un día de la semana específico. ' +
      'Si ya existe horario para ese día, lo reemplaza. ' +
      'Solo el dueño o un ADMIN pueden gestionar horarios.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['dayOfWeek', 'openTime', 'closeTime', 'isActive'],
      properties: {
        dayOfWeek: {
          type: 'integer',
          minimum: 0,
          maximum: 6,
          description: '0=Domingo, 1=Lunes, 2=Martes, 3=Miércoles, 4=Jueves, 5=Viernes, 6=Sábado',
          example: 1,
        },
        openTime:  { type: 'string', pattern: '^\\d{2}:\\d{2}$', example: '08:00' },
        closeTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$', example: '18:00' },
        isActive:  { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Horario creado o actualizado', schema: SCHEDULE_SCHEMA })
  @ApiResponse({ status: 400, description: 'openTime debe ser anterior a closeTime, o dayOfWeek fuera de rango' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Solo el dueño o ADMIN' })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  upsertSchedule(
    @Param('id') storeId: string,
    @Body(new ZodValidationPipe(CreateScheduleSchema)) dto: CreateScheduleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.upsertSchedule(
      storeId,
      dto,
      user.userId,
      user.roles.includes('ADMIN'),
      user.correlationId,
    );
  }

  @Get(':id/schedules')
  @Public()
  @ApiOperation({
    summary: 'Ver horarios de una tienda',
    description: 'Retorna los horarios configurados por día de la semana. Endpoint público.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Lista de horarios ordenados por día de la semana',
    schema: { type: 'array', items: SCHEDULE_SCHEMA },
  })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  getSchedules(@Param('id') storeId: string) {
    return this.storesService.getSchedules(storeId);
  }

  // ── Closures ───────────────────────────────────────────────────────────────

  @Post(':id/closures')
  @RequirePermission('store:close')
  @ApiOperation({
    summary: 'Programar cierre temporal',
    description:
      'Crea un cierre temporal con rango de fechas. ' +
      'Al llegar `startDate`, la tienda cambia automáticamente a `TEMPORARILY_CLOSED` y se publica `StoreStatusChanged`. ' +
      'Al llegar `endDate`, vuelve a `OPEN` automáticamente. ' +
      'Requiere permiso `store:close`.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['startDate', 'endDate'],
      properties: {
        startDate: {
          type: 'string',
          format: 'date-time',
          description: 'Debe ser una fecha futura',
          example: '2026-06-15T08:00:00Z',
        },
        endDate: {
          type: 'string',
          format: 'date-time',
          description: 'Debe ser posterior a startDate',
          example: '2026-06-15T18:00:00Z',
        },
        reason: {
          type: 'string',
          maxLength: 200,
          example: 'Mantenimiento programado de equipos',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Cierre programado', schema: CLOSURE_SCHEMA })
  @ApiResponse({ status: 400, description: 'startDate en el pasado, endDate anterior a startDate, o reason > 200 caracteres' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `store:close` requerido' })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  @ApiResponse({ status: 409, description: 'Las fechas se solapan con un cierre existente' })
  createClosure(
    @Param('id') storeId: string,
    @Body(new ZodValidationPipe(CreateClosureSchema)) dto: CreateClosureDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.createClosure(storeId, dto, user.userId, user.correlationId);
  }

  @Get(':id/closures')
  @RequirePermission('store:read')
  @ApiOperation({
    summary: 'Ver cierres programados de una tienda',
    description:
      'Lista los cierres futuros (endDate > ahora) ordenados por startDate ascendente. ' +
      'Requiere permiso `store:read`.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Cierres programados',
    schema: { type: 'array', items: CLOSURE_SCHEMA },
  })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `store:read` requerido' })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada' })
  listClosures(@Param('id') storeId: string) {
    return this.storesService.listClosures(storeId);
  }

  @Delete(':id/closures/:closureId')
  @RequirePermission('store:close')
  @ApiOperation({
    summary: 'Cancelar cierre temporal',
    description: 'Cancela un cierre programado o activo. Requiere permiso `store:close`.',
  })
  @ApiParam({ name: 'id',        description: 'UUID de la tienda',  format: 'uuid' })
  @ApiParam({ name: 'closureId', description: 'UUID del cierre',    format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Cierre cancelado' })
  @ApiResponse({ status: 400, description: 'El cierre ya expiró o fue cancelado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `store:close` requerido' })
  @ApiResponse({ status: 404, description: 'Tienda o cierre no encontrado' })
  cancelClosure(
    @Param('id')        storeId:   string,
    @Param('closureId') closureId: string,
    @CurrentUser()      user:      AuthenticatedUser,
  ) {
    return this.storesService.cancelClosure(storeId, closureId, user.userId, user.correlationId);
  }

  // ── Schedules CRUD ────────────────────────────────────────────────────────────

  @Patch(':id/schedules/:scheduleId')
  @RequirePermission('store:write')
  @ApiOperation({
    summary: 'Actualizar horario de atención',
    description: 'Actualiza un horario existente. Requiere permiso `store:write`.',
  })
  @ApiParam({ name: 'id',         description: 'UUID de la tienda',  format: 'uuid' })
  @ApiParam({ name: 'scheduleId', description: 'UUID del horario',   format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        openTime:  { type: 'string', example: '08:00' },
        closeTime: { type: 'string', example: '18:00' },
        isActive:  { type: 'boolean' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Horario actualizado', schema: SCHEDULE_SCHEMA })
  @ApiResponse({ status: 400, description: 'openTime >= closeTime o ningún campo enviado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Solo el dueño o un ADMIN puede modificar horarios' })
  @ApiResponse({ status: 404, description: 'Tienda o horario no encontrado' })
  updateSchedule(
    @Param('id')         storeId:    string,
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(UpdateScheduleSchema)) dto: UpdateScheduleDto,
    @CurrentUser()       user: AuthenticatedUser,
  ) {
    return this.storesService.updateSchedule(storeId, scheduleId, dto, user.userId, user.roles.includes('ADMIN'), user.correlationId);
  }

  @Delete(':id/schedules/:scheduleId')
  @RequirePermission('store:write')
  @ApiOperation({
    summary: 'Eliminar horario de atención',
    description: 'Elimina un horario de la tienda. Requiere permiso `store:write`.',
  })
  @ApiParam({ name: 'id',         description: 'UUID de la tienda', format: 'uuid' })
  @ApiParam({ name: 'scheduleId', description: 'UUID del horario',  format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Horario eliminado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Solo el dueño o un ADMIN puede eliminar horarios' })
  @ApiResponse({ status: 404, description: 'Tienda o horario no encontrado' })
  deleteSchedule(
    @Param('id')         storeId:    string,
    @Param('scheduleId') scheduleId: string,
    @CurrentUser()       user: AuthenticatedUser,
  ) {
    return this.storesService.deleteSchedule(storeId, scheduleId, user.userId, user.roles.includes('ADMIN'), user.correlationId);
  }

  // ── Staff ─────────────────────────────────────────────────────────────────────

  @Post(':id/staff')
  @RequirePermission('store:staff')
  @ApiOperation({
    summary: 'Asignar vendedor a la tienda',
    description: 'Asigna un usuario con rol VENDOR o ADMIN a la tienda. Requiere permiso `store:staff`.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userId'],
      properties: { userId: { type: 'string', format: 'uuid', description: 'UUID del usuario a asignar' } },
    },
  })
  @ApiResponse({ status: 201, description: 'Vendedor asignado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `store:staff` requerido' })
  @ApiResponse({ status: 404, description: 'Tienda o usuario no encontrado' })
  @ApiResponse({ status: 409, description: 'El usuario ya está asignado' })
  @ApiResponse({ status: 422, description: 'El usuario no tiene rol VENDOR o ADMIN' })
  assignStaff(
    @Param('id')   storeId: string,
    @Body(new ZodValidationPipe(AssignStaffSchema)) dto: AssignStaffDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.assignStaff(storeId, dto, user.userId, user.correlationId);
  }

  @Delete(':id/staff/:userId')
  @RequirePermission('store:staff')
  @ApiOperation({
    summary: 'Remover vendedor de la tienda',
    description: 'Desactiva la asignación del vendedor. Requiere permiso `store:staff`.',
  })
  @ApiParam({ name: 'id',     description: 'UUID de la tienda',   format: 'uuid' })
  @ApiParam({ name: 'userId', description: 'UUID del vendedor',   format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Vendedor removido' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  @ApiResponse({ status: 403, description: 'Permiso `store:staff` requerido' })
  @ApiResponse({ status: 404, description: 'Tienda o asignación no encontrada' })
  removeStaff(
    @Param('id')     storeId:     string,
    @Param('userId') staffUserId: string,
    @CurrentUser()   user: AuthenticatedUser,
  ) {
    return this.storesService.removeStaff(storeId, staffUserId, user.userId, user.correlationId);
  }

  @Get(':id/public')
  @Public()
  @ApiOperation({
    summary: 'Detalle público de tienda',
    description: 'Retorna el detalle de una tienda activa con sus horarios. Ruta pública.',
  })
  @ApiParam({ name: 'id', description: 'UUID de la tienda', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Detalle de la tienda', schema: STORE_SCHEMA })
  @ApiResponse({ status: 404, description: 'Tienda no encontrada o inactiva' })
  getPublicDetail(@Param('id') storeId: string) {
    return this.storesService.getPublicDetail(storeId);
  }
}
