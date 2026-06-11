import type { RuntimeSnapshot } from "../domain/runtime/runtime";

export interface RuntimeStore {
  getByUserId(userId: string): Promise<RuntimeSnapshot | null>;
  save(snapshot: RuntimeSnapshot): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
}
