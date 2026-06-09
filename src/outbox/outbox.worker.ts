import { Injectable } from '@nestjs/common';

@Injectable()
export class OutboxWorker {
  async processOutbox(): Promise<void> {
    throw new Error('Not implemented — see TASK-06');
  }
}
