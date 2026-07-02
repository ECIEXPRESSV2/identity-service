import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BlobServiceClient } from '@azure/storage-blob';
import pino from 'pino';

const logger = pino({ name: 'store-assets' });

/**
 * Subida de imágenes de tienda a Azure Blob Storage.
 *
 * El frontend NO sube al blob directamente: manda el archivo al backend y aquí se sube con
 * la cadena de conexión (permiso de ESCRITURA), que nunca sale del servidor. El blob se nombra
 * `<storeId>.png` en el contenedor público de logos: esa es la convención que el frontend usa
 * para resolver la URL pública de lectura (ver `storeAssets.ts` / `VITE_BLOB_STORAGE`).
 */
@Injectable()
export class StoreAssetsService {
  private readonly connStr = process.env['AZURE_STORAGE_CONNECTION_STRING'] ?? '';
  private readonly logosContainer = process.env['STORE_LOGOS_CONTAINER'] ?? 'store-logos';
  private client: BlobServiceClient | null = null;

  private getClient(): BlobServiceClient {
    if (!this.connStr) {
      throw new ServiceUnavailableException(
        'Almacenamiento de imágenes no configurado (falta AZURE_STORAGE_CONNECTION_STRING)',
      );
    }
    this.client ??= BlobServiceClient.fromConnectionString(this.connStr);
    return this.client;
  }

  /**
   * Sube el logo de una tienda como `<storeId>.png` y devuelve su URL pública.
   * Sobrescribe el blob anterior si ya existía (la tienda tiene un único logo).
   */
  async uploadStoreLogo(storeId: string, buffer: Buffer, contentType: string): Promise<string> {
    const container = this.getClient().getContainerClient(this.logosContainer);
    const blob = container.getBlockBlobClient(`${storeId}.png`);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        // Cache corto: al reemplazar el logo, los lectores ven la nueva versión en ~1 min.
        blobCacheControl: 'public, max-age=60',
      },
    });
    logger.info({ storeId, container: this.logosContainer }, 'store logo uploaded');
    return blob.url;
  }
}
