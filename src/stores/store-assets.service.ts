import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BlobServiceClient } from '@azure/storage-blob';
import pino from 'pino';

const logger = pino({ name: 'store-assets' });

/** Imagen de la galería de una tienda: URL pública + nombre del blob + fecha de subida. */
export interface StoreGalleryImage {
  /** URL pública de lectura (el contenedor es anónimo a nivel "Blob"). */
  url: string;
  /** Nombre del blob dentro de `stores/<id>/images/` (sirve para borrarla). */
  name: string;
  /** Fecha de subida (lastModified del blob), ISO-8601. */
  uploadedAt: string | null;
}

// Extensión del archivo según el MIME. El contentType real se guarda en la cabecera del blob;
// la extensión es solo cosmética en la URL, pero la mantenemos coherente.
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Subida y gestión de imágenes de tienda en Azure Blob Storage.
 *
 * Todo vive en UN solo contenedor público (`stores`, lectura anónima a nivel "Blob"), con esta
 * distribución de rutas por tienda:
 *   - Logo:    stores/<storeId>/logo/imagen.png          (uno; se sobrescribe al reemplazar)
 *   - Banner:  stores/<storeId>/banner/imagen.png        (uno; se sobrescribe al reemplazar)
 *   - Galería: stores/<storeId>/images/<timestamp>.<ext> (varias; nombre único por hora de subida)
 *
 * El frontend NO sube al blob directamente: manda el archivo al backend y aquí se sube con la
 * cadena de conexión (permiso de ESCRITURA), que nunca sale del servidor. Las URLs públicas
 * resultantes se devuelven al llamador (y para logo/banner se persisten en columnas de la tienda),
 * así el frontend ya no reconstruye rutas por convención.
 *
 * El listado de la galería lo hace el backend (con la cadena de conexión), de modo que el
 * contenedor puede quedarse en acceso anónimo "Blob" (leer un blob por su URL) sin exponer la
 * ENUMERACIÓN pública de todo el contenedor (que exigiría el nivel "Container").
 */
@Injectable()
export class StoreAssetsService {
  private readonly connStr = process.env['AZURE_STORAGE_CONNECTION_STRING'] ?? '';
  private readonly container = process.env['STORE_CONTAINER'] ?? 'stores';
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

  /** Sube el logo a `stores/<storeId>/logo/imagen.png`; devuelve su URL pública. */
  uploadStoreLogo(storeId: string, buffer: Buffer, contentType: string): Promise<string> {
    return this.uploadFixed(`${storeId}/logo/imagen.png`, buffer, contentType);
  }

  /** Sube el banner a `stores/<storeId>/banner/imagen.png`; devuelve su URL pública. */
  uploadStoreBanner(storeId: string, buffer: Buffer, contentType: string): Promise<string> {
    return this.uploadFixed(`${storeId}/banner/imagen.png`, buffer, contentType);
  }

  /**
   * Sube una imagen de galería a `stores/<storeId>/images/<timestamp>.<ext>`. El nombre incluye
   * la marca de tiempo (hasta milisegundos) + un sufijo aleatorio corto, de modo que subir varias
   * a la vez nunca se sobrescriban. Devuelve la URL pública.
   */
  uploadStoreImage(storeId: string, buffer: Buffer, contentType: string): Promise<string> {
    const ext = EXT_BY_MIME[contentType] ?? 'png';
    // 2026-07-05T19-01-45-123Z-a1b2  (seguro para URL/nombre de blob y ordenable por nombre)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 6);
    return this.uploadFixed(`${storeId}/images/${stamp}-${rand}.${ext}`, buffer, contentType, {
      // La galería es inmutable por nombre: se puede cachear agresivo (1 año).
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  /** Lista las imágenes de la galería de una tienda (prefijo `stores/<storeId>/images/`). */
  async listStoreImages(storeId: string): Promise<StoreGalleryImage[]> {
    const container = this.getClient().getContainerClient(this.container);
    const prefix = `${storeId}/images/`;
    const images: StoreGalleryImage[] = [];
    for await (const blob of container.listBlobsFlat({ prefix })) {
      images.push({
        url: `${container.url}/${blob.name}`,
        name: blob.name.slice(prefix.length),
        uploadedAt: blob.properties.lastModified?.toISOString() ?? null,
      });
    }
    // Más recientes primero (el nombre empieza por el timestamp, así que ordena por nombre desc).
    images.sort((a, b) => b.name.localeCompare(a.name));
    return images;
  }

  /**
   * Borra una imagen de la galería por su nombre (el que devuelve `listStoreImages`). Devuelve
   * true si existía y se borró, false si no existía. El nombre se sanea para impedir que se salga
   * del directorio de la tienda (no puede contener `/` ni `..`).
   */
  async deleteStoreImage(storeId: string, name: string): Promise<boolean> {
    if (!name || name.includes('/') || name.includes('..')) return false;
    const blob = this.getClient()
      .getContainerClient(this.container)
      .getBlockBlobClient(`${storeId}/images/${name}`);
    const res = await blob.deleteIfExists();
    logger.info({ storeId, name, deleted: res.succeeded }, 'store gallery image delete');
    return res.succeeded;
  }

  // Sube el buffer al blob `<path>` dentro del contenedor `stores`, sobrescribiendo si existía.
  private async uploadFixed(
    path: string,
    buffer: Buffer,
    contentType: string,
    opts?: { cacheControl?: string },
  ): Promise<string> {
    const blob = this.getClient().getContainerClient(this.container).getBlockBlobClient(path);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        // Logo/banner conservan el mismo nombre al reemplazarse, así que cache corto para que los
        // lectores vean la nueva versión en ~1 min. La galería lo sobreescribe con cache largo.
        blobCacheControl: opts?.cacheControl ?? 'public, max-age=60',
      },
    });
    logger.info({ path, container: this.container }, 'store image uploaded');
    return blob.url;
  }
}
