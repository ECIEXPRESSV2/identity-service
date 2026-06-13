import { Module } from '@nestjs/common';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { ClosureSchedulerService } from './closure-scheduler.service';

@Module({
  controllers: [StoresController],
  providers: [StoresService, ClosureSchedulerService],
  exports: [StoresService],
})
export class StoresModule {}
