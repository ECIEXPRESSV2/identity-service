import { Module } from '@nestjs/common';
import { PqrsController } from './pqrs.controller';
import { PqrsService } from './pqrs.service';

@Module({
  controllers: [PqrsController],
  providers: [PqrsService],
})
export class PqrsModule {}
