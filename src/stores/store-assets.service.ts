import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BlobServiceClient } from '@azure/storage-blob';
import pino from 'pino';

const logger = pino({ name: 'store-assets' });

/**
 * Subida de imágenes de tienda a Azure Blob Storage.
 *
 * El frontend NO sube al blob directamente: manda el archivo al backend y aquí se sube con
 * la cadena de conexión (permiso de ESCRITURA), que nunca sale del servidor. El blob se nombra
 * `<storeId>.png` en el contenedor público correspondiente (logos o banners): esa es la
 * convención que el frontend usa para resolver la URL pública de lectura
 * (ver `storeAssets.ts` / `VITE_BLOB_STORAGE`).
 */
@Injectable()
export class StoreAssetsService {
  private readonly connStr = process.env['AZURE_STORAGE_CONNECTION_STRING'] ?? '';
  private readonly logosContainer = process.env['STORE_LOGOS_CONTAINER'] ?? 'store-logos';
  private readonly bannersContainer = process.env['STORE_BANNERS_CONTAINER'] ?? 'store-banners';
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

  /** Sube el logo de una tienda a `store-logos/<storeId>.png`; devuelve su URL pública. */
  uploadStoreLogo(storeId: string, buffer: Buffer, contentType: string): Promise<string> {
    return this.upload(this.logosContainer, storeId, buffer, contentType);
  }

  /** Sube el banner de una tienda a `store-banners/<storeId>.png`; devuelve su URL pública. */
  uploadStoreBanner(storeId: string, buffer: Buffer, contentType: string): Promise<string> {
    return this.upload(this.bannersContainer, storeId, buffer, contentType);
  }

  // Sube el archivo como `<storeId>.png` en el contenedor dado (sobrescribe si ya existía).
  private async upload(
    container: string,
    storeId: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const blob = this.getClient().getContainerClient(container).getBlockBlobClient(`${storeId}.png`);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        // Cache corto: al reemplazar la imagen, los lectores ven la nueva versión en ~1 min.
        blobCacheControl: 'public, max-age=60',
      },
    });
    logger.info({ storeId, container }, 'store image uploaded');
    return blob.url;
  }
}
