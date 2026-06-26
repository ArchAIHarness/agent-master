import type { RuntimeClock } from "../../domain/runtime/runtime-clock";

export class FixedRuntimeClock implements RuntimeClock {
  constructor(private readonly current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  plusSeconds(seconds: number): Date {
    return new Date(this.current.getTime() + seconds * 1000);
  }
}

export class SystemRuntimeClock implements RuntimeClock {
  now(): Date {
    return new Date();
  }

  plusSeconds(seconds: number): Date {
    return new Date(Date.now() + seconds * 1000);
  }
}
