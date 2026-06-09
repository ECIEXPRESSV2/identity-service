import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';
import { RabbitMQService } from './rabbitmq.service';

@Module({
  providers: [OutboxService, RabbitMQService, OutboxWorker],
  exports: [OutboxService],
})
export class OutboxModule {}
