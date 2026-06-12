import Redis from "ioredis";

import type { RedisKeyValueClient } from "./redis-runtime-store";

export interface IORedisRuntimeClientOptions {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly password?: string;
}

export class IORedisRuntimeClient implements RedisKeyValueClient {
  private readonly client: Redis;

  constructor(options: IORedisRuntimeClientOptions) {
    this.client = new Redis({
      db: options.db,
      host: options.host,
      ...(options.password ? { password: options.password } : {}),
      port: options.port,
    });
  }

  async select(db: number): Promise<void> {
    await this.client.select(db);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, options: { ttlSeconds: number }): Promise<void> {
    await this.client.set(key, value, "EX", options.ttlSeconds);
  }

  async setNx(key: string, value: string, options: { ttlSeconds: number }): Promise<boolean> {
    const result = await this.client.set(key, value, "EX", options.ttlSeconds, "NX");
    return result === "OK";
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async disconnect(): Promise<void> {
    this.client.disconnect();
  }
}
