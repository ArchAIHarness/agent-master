import type { RuntimeSnapshot } from "../domain/runtime/runtime";

export interface RuntimeStore {
  getByUserId(userId: string): Promise<RuntimeSnapshot | null>;
  tryCreateForUser(snapshot: RuntimeSnapshot, ttlSeconds: number): Promise<boolean>;
  save(snapshot: RuntimeSnapshot): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
}
