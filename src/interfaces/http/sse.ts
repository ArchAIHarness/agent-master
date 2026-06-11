import type { RuntimeEvent } from "../../domain/runtime/runtime-events";

export function formatSseEvent(event: RuntimeEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}
