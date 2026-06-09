import { Injectable } from '@nestjs/common';

interface CacheEntry {
  roles: string[];
  permissions: string[];
  expiresAt: number;
}

const TTL_MS = 60_000;

@Injectable()
export class PermissionsCacheService {
  private readonly store = new Map<string, CacheEntry>();

  get(userId: string): CacheEntry | null {
    const entry = this.store.get(userId);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  set(userId: string, roles: string[], permissions: string[]): void {
    this.store.set(userId, { roles, permissions, expiresAt: Date.now() + TTL_MS });
  }

  invalidate(userId: string): void {
    this.store.delete(userId);
  }
}
