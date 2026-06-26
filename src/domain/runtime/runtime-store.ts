import type { RuntimeSnapshot } from "./runtime";

export interface RuntimeStore {
  getByUserId(userId: string): Promise<RuntimeSnapshot | null>;
  getByRuntimeId(runtimeId: string): Promise<RuntimeSnapshot | null>;
  tryCreateForUser(snapshot: RuntimeSnapshot, ttlSeconds: number): Promise<boolean>;
  save(snapshot: RuntimeSnapshot): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
}
