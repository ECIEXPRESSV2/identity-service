import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';
import { ServiceBusPublisherService } from './service-bus-publisher.service';

@Module({
  providers: [OutboxService, ServiceBusPublisherService, OutboxWorker],
  exports: [OutboxService],
})
export class OutboxModule {}
