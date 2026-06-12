import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeStore } from "../../ports/runtime-store";

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
    const value = await this.options.client.get(this.key(userId));
    return value ? (JSON.parse(value) as RuntimeSnapshot) : null;
  }

  async tryCreateForUser(snapshot: RuntimeSnapshot, ttlSeconds: number): Promise<boolean> {
    await this.ensureSelected();
    return this.options.client.setNx(this.key(snapshot.userId), JSON.stringify(snapshot), { ttlSeconds });
  }

  async save(snapshot: RuntimeSnapshot): Promise<void> {
    await this.ensureSelected();
    await this.options.client.set(this.key(snapshot.userId), JSON.stringify(snapshot), {
      ttlSeconds: this.options.ttlSeconds,
    });
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.ensureSelected();
    await this.options.client.del(this.key(userId));
  }

  private key(userId: string): string {
    return `${this.options.keyPrefix}:${userId}`;
  }

  private async ensureSelected(): Promise<void> {
    if (this.selected) {
      return;
    }
    await this.options.client.select(this.options.db);
    this.selected = true;
  }
}
