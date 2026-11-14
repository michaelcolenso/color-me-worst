/**
 * The few Cloudflare runtime types this Worker uses, declared by hand so the
 * project needs only one TypeScript configuration. `wrangler types` can
 * generate the complete set if the Worker grows.
 */
declare module 'cloudflare:workers' {
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    deleteAll(): Promise<void>;
    setAlarm(scheduledTime: number): Promise<void>;
  }

  export interface DurableObjectState {
    readonly storage: DurableObjectStorage;
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    alarm?(): void | Promise<void>;
  }
}
