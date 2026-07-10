import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { StoreStatus } from '@prisma/client';
import { StoresService } from './stores.service';

const mockPrisma = {
  store:         { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  storeSchedule: { upsert: jest.fn(), findMany: jest.fn() },
  storeStaff:    { findUnique: jest.fn() },
  storeClosure:  { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  outboxEvent:   { create: jest.fn() },
  auditLog:      { create: jest.fn() },
  $transaction:  jest.fn(),
};

const mockStoreAssets = {
  uploadStoreLogo: jest.fn(),
  uploadStoreBanner: jest.fn(),
  uploadStoreImage: jest.fn(),
  listStoreImages: jest.fn(),
  deleteStoreImage: jest.fn(),
};

function makeService() {
  return new StoresService(mockPrisma as never, mockStoreAssets as never);
}

const OWNER_ID = 'owner-uuid';
const STORE_ID = 'store-uuid';
const CORR_ID  = 'corr-uuid';

const fakeStore = {
  id: STORE_ID, ownerId: OWNER_ID, name: 'Cafetería ECI',
  location: 'Bloque A', description: null, imageUrl: null, bannerUrl: null,
  status: StoreStatus.OPEN, isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};

// Logo/banner de prueba para createStore (ambos obligatorios).
const LOGO = { buffer: Buffer.from('logo'), mimetype: 'image/png' };
const BANNER = { buffer: Buffer.from('banner'), mimetype: 'image/webp' };

describe('StoresService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
  });

  // ── createStore ────────────────────────────────────────────────────────────

  it('uploads logo + banner, then creates store, outbox event and audit log', async () => {
    const service = makeService();
    const dto = { name: 'Cafetería ECI', type: 'CAFETERIA' as const, location: 'Bloque A' };
    mockPrisma.store.findUnique.mockResolvedValue(null); // nombre libre
    mockStoreAssets.uploadStoreLogo.mockResolvedValue('https://acct/stores/x/logo/imagen.png');
    mockStoreAssets.uploadStoreBanner.mockResolvedValue('https://acct/stores/x/banner/imagen.png');
    mockPrisma.store.create.mockResolvedValue(fakeStore);
    mockPrisma.outboxEvent.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.createStore(OWNER_ID, dto, LOGO, BANNER, CORR_ID);

    expect(mockStoreAssets.uploadStoreLogo).toHaveBeenCalled();
    expect(mockStoreAssets.uploadStoreBanner).toHaveBeenCalled();
    expect(mockPrisma.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          imageUrl: 'https://acct/stores/x/logo/imagen.png',
          bannerUrl: 'https://acct/stores/x/banner/imagen.png',
        }),
      }),
    );
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'StoreCreated' }) }),
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(result.id).toBe(STORE_ID);
  });

  it('rejects create when the logo is missing (mandatory)', async () => {
    const service = makeService();
    const dto = { name: 'Cafetería ECI', type: 'CAFETERIA' as const, location: 'Bloque A' };

    await expect(
      service.createStore(OWNER_ID, dto, undefined as never, BANNER, CORR_ID),
    ).rejects.toThrow(BadRequestException);
    expect(mockStoreAssets.uploadStoreLogo).not.toHaveBeenCalled();
  });

  it('rejects create when the banner is missing (mandatory)', async () => {
    const service = makeService();
    const dto = { name: 'Cafetería ECI', type: 'CAFETERIA' as const, location: 'Bloque A' };

    await expect(
      service.createStore(OWNER_ID, dto, LOGO, undefined as never, CORR_ID),
    ).rejects.toThrow(BadRequestException);
    expect(mockStoreAssets.uploadStoreBanner).not.toHaveBeenCalled();
  });

  it('rejects create when the store name already exists (409), without uploading', async () => {
    const service = makeService();
    const dto = { name: 'Cafetería ECI', type: 'CAFETERIA' as const, location: 'Bloque A' };
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore); // nombre ocupado

    await expect(
      service.createStore(OWNER_ID, dto, LOGO, BANNER, CORR_ID),
    ).rejects.toThrow(ConflictException);
    expect(mockStoreAssets.uploadStoreLogo).not.toHaveBeenCalled();
  });

  // ── findById ───────────────────────────────────────────────────────────────

  it('throws NotFoundException when store does not exist', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(null);

    await expect(service.findById(STORE_ID)).rejects.toThrow(NotFoundException);
  });

  it('returns store with schedules', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue({ ...fakeStore, schedules: [] });

    const result = await service.findById(STORE_ID);
    expect(result.id).toBe(STORE_ID);
    expect(result.schedules).toEqual([]);
  });

  // ── updateStore ────────────────────────────────────────────────────────────

  it('allows owner to update their store', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.store.update.mockResolvedValue({ ...fakeStore, name: 'Nuevo nombre' });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.updateStore(STORE_ID, { name: 'Nuevo nombre' }, OWNER_ID, false, CORR_ID);
    expect(result.name).toBe('Nuevo nombre');
  });

  it('allows admin to update any store regardless of ownership', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.store.update.mockResolvedValue(fakeStore);
    mockPrisma.auditLog.create.mockResolvedValue({});

    await expect(
      service.updateStore(STORE_ID, { name: 'x' }, 'other-user', true, CORR_ID),
    ).resolves.toBeDefined();
  });

  it('throws ForbiddenException when non-owner non-admin tries to update', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.updateStore(STORE_ID, { name: 'hack' }, 'attacker', false, CORR_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── uploadLogo ─────────────────────────────────────────────────────────────

  it('uploads logo to blob and stores the returned URL in imageUrl', async () => {
    const service = makeService();
    const url = 'https://acct.blob.core.windows.net/store-logos/store-uuid.png';
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockStoreAssets.uploadStoreLogo.mockResolvedValue(url);
    mockPrisma.store.update.mockResolvedValue({ ...fakeStore, imageUrl: url });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const buffer = Buffer.from('img');
    const result = await service.uploadLogo(
      STORE_ID, { buffer, mimetype: 'image/png' }, OWNER_ID, false, CORR_ID,
    );

    expect(mockStoreAssets.uploadStoreLogo).toHaveBeenCalledWith(STORE_ID, buffer, 'image/png');
    expect(mockPrisma.store.update).toHaveBeenCalledWith({ where: { id: STORE_ID }, data: { imageUrl: url } });
    expect(result.imageUrl).toBe(url);
  });

  it('throws BadRequestException for a non-image mime type', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.uploadLogo(STORE_ID, { buffer: Buffer.from('x'), mimetype: 'application/pdf' }, OWNER_ID, false, CORR_ID),
    ).rejects.toThrow(BadRequestException);
    expect(mockStoreAssets.uploadStoreLogo).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when non-owner non-admin uploads a logo', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.uploadLogo(STORE_ID, { buffer: Buffer.from('x'), mimetype: 'image/png' }, 'attacker', false, CORR_ID),
    ).rejects.toThrow(ForbiddenException);
    expect(mockStoreAssets.uploadStoreLogo).not.toHaveBeenCalled();
  });

  // ── uploadBanner ───────────────────────────────────────────────────────────

  it('uploads banner to blob, persists bannerUrl and logs audit (no event)', async () => {
    const service = makeService();
    const url = 'https://acct.blob.core.windows.net/stores/store-uuid/banner/imagen.png';
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockStoreAssets.uploadStoreBanner.mockResolvedValue(url);
    mockPrisma.store.update.mockResolvedValue({ ...fakeStore, bannerUrl: url });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const buffer = Buffer.from('banner');
    const result = await service.uploadBanner(
      STORE_ID, { buffer, mimetype: 'image/webp' }, OWNER_ID, false,
    );

    expect(mockStoreAssets.uploadStoreBanner).toHaveBeenCalledWith(STORE_ID, buffer, 'image/webp');
    expect(mockPrisma.store.update).toHaveBeenCalledWith({ where: { id: STORE_ID }, data: { bannerUrl: url } });
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(result).toEqual({ storeId: STORE_ID, bannerUrl: url });
  });

  it('throws BadRequestException for a non-image banner mime type', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.uploadBanner(STORE_ID, { buffer: Buffer.from('x'), mimetype: 'application/pdf' }, OWNER_ID, false),
    ).rejects.toThrow(BadRequestException);
    expect(mockStoreAssets.uploadStoreBanner).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when non-owner non-admin uploads a banner', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.uploadBanner(STORE_ID, { buffer: Buffer.from('x'), mimetype: 'image/png' }, 'attacker', false),
    ).rejects.toThrow(ForbiddenException);
    expect(mockStoreAssets.uploadStoreBanner).not.toHaveBeenCalled();
  });

  // ── galería de imágenes ─────────────────────────────────────────────────────

  it('lists gallery images for a store', async () => {
    const service = makeService();
    const imgs = [{ url: 'https://acct/stores/s/images/a.png', name: 'a.png', uploadedAt: null }];
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockStoreAssets.listStoreImages.mockResolvedValue(imgs);

    const result = await service.listImages(STORE_ID);

    expect(mockStoreAssets.listStoreImages).toHaveBeenCalledWith(STORE_ID);
    expect(result).toEqual({ storeId: STORE_ID, images: imgs });
  });

  it('uploads several gallery images and returns the refreshed gallery', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockStoreAssets.uploadStoreImage
      .mockResolvedValueOnce('https://acct/stores/s/images/1.png')
      .mockResolvedValueOnce('https://acct/stores/s/images/2.png');
    mockStoreAssets.listStoreImages.mockResolvedValue([]);
    mockPrisma.auditLog.create.mockResolvedValue({});

    const files = [
      { buffer: Buffer.from('a'), mimetype: 'image/png' },
      { buffer: Buffer.from('b'), mimetype: 'image/webp' },
    ];
    await service.addImages(STORE_ID, files, OWNER_ID, false);

    expect(mockStoreAssets.uploadStoreImage).toHaveBeenCalledTimes(2);
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(mockStoreAssets.listStoreImages).toHaveBeenCalledWith(STORE_ID);
  });

  it('rejects gallery upload with a non-image mime type', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.addImages(STORE_ID, [{ buffer: Buffer.from('x'), mimetype: 'application/pdf' }], OWNER_ID, false),
    ).rejects.toThrow(BadRequestException);
    expect(mockStoreAssets.uploadStoreImage).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when a non-owner, non-staff adds gallery images', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeStaff.findUnique.mockResolvedValue(null); // no es staff

    await expect(
      service.addImages(STORE_ID, [{ buffer: Buffer.from('x'), mimetype: 'image/png' }], 'attacker', false),
    ).rejects.toThrow(ForbiddenException);
    expect(mockStoreAssets.uploadStoreImage).not.toHaveBeenCalled();
  });

  it('allows ACTIVE staff (non-owner) to add gallery images', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeStaff.findUnique.mockResolvedValue({ isActive: true });
    mockStoreAssets.uploadStoreImage.mockResolvedValue('https://acct/stores/s/images/1.png');
    mockStoreAssets.listStoreImages.mockResolvedValue([]);
    mockPrisma.auditLog.create.mockResolvedValue({});

    await service.addImages(STORE_ID, [{ buffer: Buffer.from('a'), mimetype: 'image/png' }], 'staff-user', false);

    expect(mockPrisma.storeStaff.findUnique).toHaveBeenCalledWith({
      where: { storeId_userId: { storeId: STORE_ID, userId: 'staff-user' } },
    });
    expect(mockStoreAssets.uploadStoreImage).toHaveBeenCalledTimes(1);
  });

  it('rejects a REMOVED (inactive) staff member from adding gallery images', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeStaff.findUnique.mockResolvedValue({ isActive: false });

    await expect(
      service.addImages(STORE_ID, [{ buffer: Buffer.from('x'), mimetype: 'image/png' }], 'ex-staff', false),
    ).rejects.toThrow(ForbiddenException);
    expect(mockStoreAssets.uploadStoreImage).not.toHaveBeenCalled();
  });

  it('deletes a gallery image by name', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockStoreAssets.deleteStoreImage.mockResolvedValue(true);
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.deleteImage(STORE_ID, 'a.png', OWNER_ID, false);

    expect(mockStoreAssets.deleteStoreImage).toHaveBeenCalledWith(STORE_ID, 'a.png');
    expect(result).toEqual({ storeId: STORE_ID, name: 'a.png', message: 'Imagen eliminada' });
  });

  it('throws NotFoundException when deleting a gallery image that does not exist', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockStoreAssets.deleteStoreImage.mockResolvedValue(false);

    await expect(
      service.deleteImage(STORE_ID, 'missing.png', OWNER_ID, false),
    ).rejects.toThrow(NotFoundException);
  });

  // ── updateStatus ───────────────────────────────────────────────────────────

  it('publishes StoreStatusChanged outbox event on status change', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.store.update.mockResolvedValue({ ...fakeStore, status: StoreStatus.CLOSED });
    mockPrisma.outboxEvent.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    await service.updateStatus(STORE_ID, { status: 'CLOSED' }, OWNER_ID, false, CORR_ID);

    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'StoreStatusChanged' }),
      }),
    );
  });

  it('is idempotent — skips transaction when status is unchanged', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore); // already OPEN

    await service.updateStatus(STORE_ID, { status: 'OPEN' }, OWNER_ID, false, CORR_ID);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // ── upsertSchedule ─────────────────────────────────────────────────────────

  it('throws BadRequestException when openTime >= closeTime', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.upsertSchedule(STORE_ID, { dayOfWeek: 1, openTime: '18:00', closeTime: '08:00', isActive: true }, OWNER_ID, false, CORR_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when openTime equals closeTime', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.upsertSchedule(STORE_ID, { dayOfWeek: 1, openTime: '08:00', closeTime: '08:00', isActive: true }, OWNER_ID, false, CORR_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('upserts schedule with valid times', async () => {
    const service = makeService();
    const schedule = { id: 'sch-1', storeId: STORE_ID, dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true };
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeSchedule.upsert.mockResolvedValue(schedule);

    const result = await service.upsertSchedule(
      STORE_ID, { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true }, OWNER_ID, false, CORR_ID,
    );
    expect(result.openTime).toBe('08:00');
  });

  it('throws ForbiddenException when non-owner tries to upsert schedule', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeStaff.findUnique.mockResolvedValue(null); // no es staff de ninguna tienda

    await expect(
      service.upsertSchedule(STORE_ID, { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true }, 'attacker', false, CORR_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows ACTIVE staff (non-owner, non-admin) to upsert a schedule for their assigned store', async () => {
    const service = makeService();
    const schedule = { id: 'sch-1', storeId: STORE_ID, dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true };
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeStaff.findUnique.mockResolvedValue({ isActive: true });
    mockPrisma.storeSchedule.upsert.mockResolvedValue(schedule);

    const result = await service.upsertSchedule(
      STORE_ID, { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true }, 'staff-user', false, CORR_ID,
    );

    expect(mockPrisma.storeStaff.findUnique).toHaveBeenCalledWith({
      where: { storeId_userId: { storeId: STORE_ID, userId: 'staff-user' } },
    });
    expect(result.openTime).toBe('08:00');
  });

  it('scopes staff access per store — being staff of another store does not grant access here', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore); // esta consulta es sobre STORE_ID
    // El vendedor SÍ es staff activo, pero de OTRA tienda — la búsqueda por storeId_userId de
    // STORE_ID no lo encuentra, así que el resultado es null (no existe esa fila compuesta).
    mockPrisma.storeStaff.findUnique.mockResolvedValue(null);

    await expect(
      service.upsertSchedule(
        STORE_ID,
        { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true },
        'vendor-of-other-store',
        false,
        CORR_ID,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(mockPrisma.storeStaff.findUnique).toHaveBeenCalledWith({
      where: { storeId_userId: { storeId: STORE_ID, userId: 'vendor-of-other-store' } },
    });
  });

  // ── getSchedules ───────────────────────────────────────────────────────────

  it('throws NotFoundException for unknown store on getSchedules', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(null);

    await expect(service.getSchedules(STORE_ID)).rejects.toThrow(NotFoundException);
  });

  it('returns schedules ordered by dayOfWeek', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeSchedule.findMany.mockResolvedValue([{ id: '1', dayOfWeek: 0 }, { id: '2', dayOfWeek: 3 }]);

    const result = await service.getSchedules(STORE_ID);
    expect(result).toHaveLength(2);
  });

  // ── createClosure ──────────────────────────────────────────────────────────

  it('throws NotFoundException when store does not exist on createClosure', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(null);

    await expect(
      service.createClosure(STORE_ID, { startDate: future(1), endDate: future(2) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when startDate is in the past', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    const past = new Date(Date.now() - 60_000);

    await expect(
      service.createClosure(STORE_ID, { startDate: past, endDate: future(1) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when endDate is not after startDate', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.createClosure(STORE_ID, { startDate: future(2), endDate: future(1) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws ConflictException when dates overlap an existing closure', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeClosure.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.createClosure(STORE_ID, { startDate: future(1), endDate: future(3) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(ConflictException);
  });

  it('creates closure and audit log', async () => {
    const service = makeService();
    const start = future(1);
    const end   = future(2);
    const fakeClosure = { id: 'closure-1', storeId: STORE_ID, startDate: start, endDate: end, reason: null, createdBy: OWNER_ID, createdAt: new Date() };

    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeClosure.findFirst.mockResolvedValue(null);
    mockPrisma.storeClosure.create.mockResolvedValue(fakeClosure);
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.createClosure(STORE_ID, { startDate: start, endDate: end }, OWNER_ID, CORR_ID);

    expect(mockPrisma.storeClosure.create).toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(result.id).toBe('closure-1');
  });

  // ── listClosures ───────────────────────────────────────────────────────────

  it('returns only future closures', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeClosure.findMany.mockResolvedValue([{ id: 'c-1' }]);

    const result = await service.listClosures(STORE_ID);

    expect(mockPrisma.storeClosure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ endDate: expect.objectContaining({ gt: expect.any(Date) }) }),
      }),
    );
    expect(result).toHaveLength(1);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function future(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}
