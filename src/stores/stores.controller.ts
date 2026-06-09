import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { StoresService } from './stores.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CreateStoreSchema, type CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreSchema, type UpdateStoreDto } from './dto/update-store.dto';
import { UpdateStoreStatusSchema, type UpdateStoreStatusDto } from './dto/update-store-status.dto';
import { CreateScheduleSchema, type CreateScheduleDto } from './dto/create-schedule.dto';
import { CreateClosureSchema, type CreateClosureDto } from './dto/create-closure.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Post()
  @RequirePermission('store:write')
  create(
    @Body(new ZodValidationPipe(CreateStoreSchema)) dto: CreateStoreDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.createStore(user.userId, dto, user.correlationId);
  }

  @Get()
  @Public()
  list() {
    return this.storesService.listStores();
  }

  @Get(':id')
  @Public()
  findOne(@Param('id') id: string) {
    return this.storesService.findById(id);
  }

  @Put(':id')
  @RequirePermission('store:write')
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
    );
  }

  @Patch(':id/status')
  @RequirePermission('store:write')
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

  @Post(':id/schedules')
  @RequirePermission('store:write')
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
    );
  }

  @Get(':id/schedules')
  @Public()
  getSchedules(@Param('id') storeId: string) {
    return this.storesService.getSchedules(storeId);
  }

  @Post(':id/closures')
  @RequirePermission('store:close')
  createClosure(
    @Param('id') storeId: string,
    @Body(new ZodValidationPipe(CreateClosureSchema)) dto: CreateClosureDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storesService.createClosure(storeId, dto, user.userId, user.correlationId);
  }

  @Get(':id/closures')
  @RequirePermission('store:read')
  listClosures(@Param('id') storeId: string) {
    return this.storesService.listClosures(storeId);
  }
}
