export interface RuntimeClock {
  now(): Date;
  plusSeconds(seconds: number): Date;
}
