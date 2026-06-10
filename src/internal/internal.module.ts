import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InternalService } from './internal.service';
import { InternalController } from './internal.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [InternalController],
  providers:   [InternalService],
})
export class InternalModule {}
