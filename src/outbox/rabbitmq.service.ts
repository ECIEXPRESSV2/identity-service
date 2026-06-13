import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import * as amqplib from 'amqplib';
import pino from 'pino';

const logger = pino({ name: 'rabbitmq' });

@Injectable()
export class RabbitMQService implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

  private readonly url = process.env['RABBITMQ_URL'] ?? '';
  private readonly exchange = process.env['RABBITMQ_EXCHANGE'] ?? '';

  async onApplicationBootstrap(): Promise<void> {
    if (!this.url || !this.exchange) {
      logger.warn('RABBITMQ_URL or RABBITMQ_EXCHANGE not configured — publishing disabled');
      return;
    }
    await this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  async publish(routingKey: string, message: object): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }
    const buffer = Buffer.from(JSON.stringify(message));
    const ok = this.channel.publish(this.exchange, routingKey, buffer, {
      persistent: true,
      contentType: 'application/json',
    });
    if (!ok) {
      throw new Error('RabbitMQ channel buffer full — back-pressure');
    }
  }

  get isConnected(): boolean {
    return this.channel !== null;
  }

  private async connect(): Promise<void> {
    try {
      this.connection = await amqplib.connect(this.url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.exchange, 'topic', { durable: true });

      this.connection.once('error', (err: unknown) => {
        logger.error({ err }, 'RabbitMQ connection error — publishing disabled until restart');
        this.channel = null;
        this.connection = null;
      });

      logger.info({ exchange: this.exchange }, 'RabbitMQ connected');
    } catch (err) {
      logger.error({ err }, 'Could not connect to RabbitMQ — publishing disabled');
    }
  }
}
