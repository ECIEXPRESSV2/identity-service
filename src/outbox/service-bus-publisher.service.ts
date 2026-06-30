import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ServiceBusClient, ServiceBusSender } from '@azure/service-bus';
import { DefaultAzureCredential } from '@azure/identity';
import pino from 'pino';

const logger = pino({ name: 'service-bus' });

/**
 * Publisher de Azure Service Bus (Managed Identity / DefaultAzureCredential). identity
 * es publisher-only (patrón outbox): solo crea un sender sobre el topic compartido y
 * publica con subject = routingKey. Reemplaza al publisher de amqplib.
 *
 * Si el namespace no está configurado, deshabilita la publicación con un warning (igual
 * que el comportamiento anterior con RABBITMQ_URL).
 */
@Injectable()
export class ServiceBusPublisherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private client: ServiceBusClient | null = null;
  private sender: ServiceBusSender | null = null;

  private readonly connStr =
    process.env['SERVICE_BUS_CONNECTION_STRING'] ?? '';
  private readonly fqns =
    process.env['SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE'] ?? '';
  private readonly topic =
    process.env['SERVICE_BUS_TOPIC'] ?? 'eciexpress_events';

  onApplicationBootstrap(): void {
    if (!this.connStr && !this.fqns) {
      logger.warn(
        'SERVICE_BUS_CONNECTION_STRING / SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE not configured — publishing disabled',
      );
      return;
    }
    try {
      this.client = this.connStr
        ? new ServiceBusClient(this.connStr)
        : new ServiceBusClient(this.fqns, new DefaultAzureCredential());
      this.sender = this.client.createSender(this.topic);
      logger.info({ topic: this.topic }, 'Service Bus connected');
    } catch (err) {
      logger.error({ err }, 'Could not init Service Bus — publishing disabled');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sender?.close().catch(() => undefined);
    await this.client?.close().catch(() => undefined);
  }

  async publish(routingKey: string, message: object): Promise<void> {
    if (!this.sender) {
      throw new Error('Service Bus sender not available');
    }
    await this.sender.sendMessages({
      body: message,
      subject: routingKey,
      applicationProperties: { routingKey },
      contentType: 'application/json',
    });
  }

  get isConnected(): boolean {
    return this.sender !== null;
  }
}
