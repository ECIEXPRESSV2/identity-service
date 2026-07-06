/**
 * Migración única: mueve las imágenes de tienda de los contenedores viejos
 *   store-logos/<id>.png    →  stores/<id>/logo/imagen.png
 *   store-banners/<id>.png  →  stores/<id>/banner/imagen.png
 * y reapunta las URLs en la BD (stores.imageUrl / stores.bannerUrl) al nuevo contenedor.
 *
 * Idempotente: reejecutar sobrescribe los blobs destino y vuelve a fijar las URLs (sin daño).
 * NO borra los contenedores viejos (eso se decide aparte, cuando se confirme que todo quedó bien).
 *
 * Uso:
 *   npx ts-node --project tsconfig.json scripts/migrate-store-blobs.ts --dry-run   # previsualiza
 *   npx ts-node --project tsconfig.json scripts/migrate-store-blobs.ts             # aplica
 *
 * Requiere en el entorno (los toma del .env): DATABASE_URL, AZURE_STORAGE_CONNECTION_STRING.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { BlobServiceClient } from '@azure/storage-blob';

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_CONTAINER = process.env['STORE_CONTAINER'] ?? 'stores';

// (contenedor origen, campo en BD, subruta destino dentro de stores/<id>/)
const JOBS = [
  { source: 'store-logos', field: 'imageUrl' as const, subpath: 'logo/imagen.png' },
  { source: 'store-banners', field: 'bannerUrl' as const, subpath: 'banner/imagen.png' },
];

async function main() {
  const connStr = process.env['AZURE_STORAGE_CONNECTION_STRING'];
  if (!connStr) throw new Error('Falta AZURE_STORAGE_CONNECTION_STRING');

  const blobSvc = BlobServiceClient.fromConnectionString(connStr);
  const target = blobSvc.getContainerClient(TARGET_CONTAINER);

  const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] });
  const prisma = new PrismaClient({ adapter });

  console.log(`\n${DRY_RUN ? '🔍 DRY-RUN (no escribe nada)' : '🚀 MIGRANDO'} → contenedor destino: ${TARGET_CONTAINER}\n`);

  let copied = 0;
  let dbUpdated = 0;
  const orphanBlobs: string[] = [];

  for (const job of JOBS) {
    const src = blobSvc.getContainerClient(job.source);
    if (!(await src.exists())) {
      console.log(`⚠️  Contenedor origen '${job.source}' no existe, se omite.`);
      continue;
    }

    console.log(`── ${job.source} → stores/<id>/${job.subpath} (BD: ${job.field}) ──`);

    for await (const blob of src.listBlobsFlat()) {
      const match = blob.name.match(/^([0-9a-fA-F-]{36})\.png$/);
      if (!match) {
        console.log(`   ? ${blob.name}: nombre inesperado (no <uuid>.png), se omite.`);
        continue;
      }
      const storeId = match[1];
      const destPath = `${storeId}/${job.subpath}`;
      const newUrl = `${target.url}/${destPath}`;

      // ¿Existe la tienda en BD?
      const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
      const inDb = store !== null;
      if (!inDb) orphanBlobs.push(`${job.source}/${blob.name}`);

      console.log(
        `   • ${storeId}  ${inDb ? '' : '(sin fila en BD) '}→ ${destPath}`,
      );

      if (DRY_RUN) continue;

      // 1) Copiar el blob (download + upload preservando content-type).
      const srcBlob = src.getBlockBlobClient(blob.name);
      const props = await srcBlob.getProperties();
      const buffer = await srcBlob.downloadToBuffer();
      await target.getBlockBlobClient(destPath).uploadData(buffer, {
        blobHTTPHeaders: {
          blobContentType: props.contentType ?? 'image/png',
          blobCacheControl: 'public, max-age=60',
        },
      });
      copied++;

      // 2) Reapuntar la URL en BD (solo si la tienda existe).
      if (inDb) {
        const res = await prisma.store.updateMany({
          where: { id: storeId },
          data: { [job.field]: newUrl },
        });
        dbUpdated += res.count;
      }
    }
    console.log('');
  }

  // Verificación: ¿quedan URLs apuntando a los contenedores viejos?
  const stillOld = await prisma.store.count({
    where: {
      OR: [
        { imageUrl: { contains: '/store-logos/' } },
        { bannerUrl: { contains: '/store-banners/' } },
      ],
    },
  });

  console.log('──────────────────────────────────────────');
  console.log(`Blobs copiados:        ${copied}`);
  console.log(`Filas de BD actualizadas: ${dbUpdated}`);
  console.log(`Blobs sin fila en BD (huérfanos): ${orphanBlobs.length}`);
  if (orphanBlobs.length) orphanBlobs.forEach((o) => console.log(`   - ${o}`));
  console.log(`Tiendas con URL vieja restante: ${stillOld}`);
  console.log('──────────────────────────────────────────\n');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
