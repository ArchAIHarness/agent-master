import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeStore } from "../../domain/runtime/runtime-store";

export interface RedisKeyValueClient {
  select(db: number): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { ttlSeconds: number }): Promise<void>;
  setNx(key: string, value: string, options: { ttlSeconds: number }): Promise<boolean>;
  del(key: string): Promise<void>;
}

export interface RedisRuntimeStoreOptions {
  readonly client: RedisKeyValueClient;
  readonly db: number;
  readonly keyPrefix: string;
  readonly ttlSeconds: number;
}

export class RedisRuntimeStore implements RuntimeStore {
  private selected = false;

  constructor(private readonly options: RedisRuntimeStoreOptions) {}

  async getByUserId(userId: string): Promise<RuntimeSnapshot | null> {
    await this.ensureSelected();
    const value = await this.options.client.get(this.userKey(userId));
    return value ? (JSON.parse(value) as RuntimeSnapshot) : null;
  }

  async getByRuntimeId(runtimeId: string): Promise<RuntimeSnapshot | null> {
    await this.ensureSelected();
    const userId = await this.options.client.get(this.runtimeIdIndexKey(runtimeId));
    if (!userId) {
      return null;
    }
    return this.getByUserId(userId);
  }

  async tryCreateForUser(snapshot: RuntimeSnapshot, ttlSeconds: number): Promise<boolean> {
    await this.ensureSelected();
    const created = await this.options.client.setNx(this.userKey(snapshot.userId), JSON.stringify(snapshot), { ttlSeconds });
    if (created) {
      await this.options.client.set(this.runtimeIdIndexKey(snapshot.runtimeId), snapshot.userId, {
        ttlSeconds,
      });
    }
    return created;
  }

  async save(snapshot: RuntimeSnapshot): Promise<void> {
    await this.ensureSelected();
    await this.options.client.set(this.userKey(snapshot.userId), JSON.stringify(snapshot), {
      ttlSeconds: this.options.ttlSeconds,
    });
    await this.options.client.set(this.runtimeIdIndexKey(snapshot.runtimeId), snapshot.userId, {
      ttlSeconds: this.options.ttlSeconds,
    });
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.ensureSelected();
    const snapshot = await this.getByUserId(userId);
    if (snapshot) {
      await this.options.client.del(this.runtimeIdIndexKey(snapshot.runtimeId));
    }
    await this.options.client.del(this.userKey(userId));
  }

  private userKey(userId: string): string {
    return `${this.options.keyPrefix}:${userId}`;
  }

  private runtimeIdIndexKey(runtimeId: string): string {
    return `${this.options.keyPrefix}:runtimeId:${runtimeId}`;
  }

  private async ensureSelected(): Promise<void> {
    if (this.selected) {
      return;
    }
    await this.options.client.select(this.options.db);
    this.selected = true;
  }
}
