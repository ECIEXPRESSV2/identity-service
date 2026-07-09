import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';
import type { BlobSASSignatureValues } from '@azure/storage-blob';
import pino from 'pino';

const logger = pino({ name: 'profile-assets' });

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

@Injectable()
export class ProfileAssetsService {
  private readonly connStr =
    process.env['AZURE_STORAGE_CONNECTION_STRING'] ?? '';
  private readonly container =
    process.env['PROFILE_PHOTOS_CONTAINER'] ?? 'profile-photos';
  private client: BlobServiceClient | null = null;

  private cred: StorageSharedKeyCredential | null = null;
  private getCred(): StorageSharedKeyCredential {
    if (!this.connStr) {
      throw new ServiceUnavailableException(
        'Almacenamiento de fotos de perfil no configurado (falta AZURE_STORAGE_CONNECTION_STRING)',
      );
    }
    if (!this.cred) {
      const parts = this.connStr.split(';').reduce(
        (acc, part) => {
          const idx = part.indexOf('=');
          if (idx === -1) return acc;
          acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
          return acc;
        },
        {} as Record<string, string>,
      );
      this.cred = new StorageSharedKeyCredential(parts['AccountName'], parts['AccountKey']);
    }
    return this.cred;
  }

  private getClient(): BlobServiceClient {
    this.getCred();
    this.client ??= BlobServiceClient.fromConnectionString(this.connStr);
    return this.client;
  }

  private sasQuery(blobName: string): string {
    const sasOptions: BlobSASSignatureValues = {
      containerName: this.container,
      blobName,
      startsOn: new Date(),
      expiresOn: new Date(Date.now() + 60 * 60 * 1000),
      permissions: BlobSASPermissions.parse('r'),
    };
    return generateBlobSASQueryParameters(sasOptions, this.getCred()).toString();
  }

  signUrl(blobUrl: string | null | undefined): string | null {
    if (!blobUrl) return null;
    if (blobUrl.includes('?')) return blobUrl;
    const marker = `/${this.container}/`;
    const idx = blobUrl.indexOf(marker);
    if (idx === -1) return blobUrl;
    const blobName = blobUrl.slice(idx + marker.length);
    return `${blobUrl}?${this.sasQuery(blobName)}`;
  }

  async uploadProfilePhoto(
    userId: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const ext = EXT_BY_MIME[contentType] ?? 'png';
    const blobName = `profiles/${userId}/avatar.${ext}`;
    const blob = this.getClient()
      .getContainerClient(this.container)
      .getBlockBlobClient(blobName);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: 'public, max-age=60',
      },
    });
    logger.info({ userId, container: this.container }, 'profile photo uploaded');
    return blob.url;
  }

  async deleteProfilePhoto(userId: string): Promise<boolean> {
    const container = this.getClient().getContainerClient(this.container);
    const prefix = `profiles/${userId}/avatar.`;
    const images: string[] = [];
    for await (const b of container.listBlobsFlat({ prefix })) {
      images.push(b.name);
    }
    if (images.length === 0) return false;
    const results = await Promise.all(
      images.map((name) => container.getBlockBlobClient(name).deleteIfExists()),
    );
    logger.info({ userId, deleted: results.some((r) => r.succeeded) }, 'profile photo deleted');
    return results.some((r) => r.succeeded);
  }
}
