import type { RuntimeEvent } from "./runtime-events";

export type RuntimeEventListener = (event: RuntimeEvent) => void | Promise<void>;

export interface RuntimeEventBus {
  publish(event: RuntimeEvent): Promise<void>;
  subscribe(userId: string, listener: RuntimeEventListener): () => void;
}
