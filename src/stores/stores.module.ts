import { Module } from '@nestjs/common';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { StoreAssetsService } from './store-assets.service';
import { ClosureSchedulerService } from './closure-scheduler.service';

@Module({
  controllers: [StoresController],
  providers: [StoresService, StoreAssetsService, ClosureSchedulerService],
  exports: [StoresService],
})
export class StoresModule {}
