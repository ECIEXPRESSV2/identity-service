import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateStoreDto } from './dto/create-store.dto';
import type { UpdateStoreDto } from './dto/update-store.dto';
import type { CreateScheduleDto } from './dto/create-schedule.dto';
import type { CreateClosureDto } from './dto/create-closure.dto';


@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async createStore(_ownerId: string, _dto: CreateStoreDto, _correlationId: string) {
    throw new Error('Not implemented — see TASK-07');
  }

  async listStores() {
    return this.prisma.store.findMany({ where: { isActive: true } });
  }

  async findById(_id: string) {
    throw new Error('Not implemented — see TASK-07');
  }

  async updateStore(_id: string, _dto: UpdateStoreDto, _actorId: string, _correlationId: string) {
    throw new Error('Not implemented — see TASK-07');
  }

  async upsertSchedule(_storeId: string, _dto: CreateScheduleDto, _actorId: string) {
    throw new Error('Not implemented — see TASK-07');
  }

  async getSchedules(_storeId: string) {
    throw new Error('Not implemented — see TASK-07');
  }

  async createClosure(_storeId: string, _dto: CreateClosureDto, _actorId: string, _correlationId: string) {
    throw new Error('Not implemented — see TASK-08');
  }

  async listClosures(_storeId: string) {
    throw new Error('Not implemented — see TASK-08');
  }
}
