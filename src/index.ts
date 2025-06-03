import Redis from "ioredis";
import type { RedisOptions } from "ioredis";
import { randomBytes } from "crypto";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

declare module "ioredis" {
  interface Redis {
    /**
     * Custom command to release a lock.
     * KEYS[1]: resource_name
     * ARGV[1]: lock_value
     * Returns 1 if the lock was deleted, 0 otherwise.
     */
    releaseLockScript(key: string, value: string): Promise<number>;

    /**
     * Custom command to extend a lock's TTL.
     * KEYS[1]: resource_name
     * ARGV[1]: lock_value
     * ARGV[2]: new_ttl_in_milliseconds
     * Returns 1 if the TTL was updated, 0 otherwise.
     */
    extendLockScript(key: string, value: string, ttl: number): Promise<number>;
  }
}

const UNLOCK_SCRIPT = `
  if redis.call("get",KEYS[1]) == ARGV[1] then
    return redis.call("del",KEYS[1])
  else
    return 0
  end
`;

const EXTEND_SCRIPT = `
  if redis.call("get",KEYS[1]) == ARGV[1] then
    return redis.call("pexpire",KEYS[1],ARGV[2])
  else
    return 0
  end
`;

export interface AcquiredLock {
  resource: string; // The resource identifier
  value: string; // The random value used for this lock
  validity: number; // The effective time (in ms) for which this lock is valid
  expiration: number; // Timestamp (in ms) when this lock is expected to expire
  attempts: number; // Number of attempts it took to acquire the lock
  release: () => Promise<void>; // Function to release this lock
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export class LockAcquisitionError extends LockError {
  public readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = "LockAcquisitionError";
    this.attempts = attempts;
  }
}

export class LockExtendError extends LockError {
  constructor(message: string) {
    super(message);
    this.name = "LockExtendError";
  }
}
export class Redlock {
  private clients: Redis[];
  private quorum: number;
  private readonly defaultRetryCount: number;
  private readonly defaultRetryDelay: number;
  private readonly defaultRetryJitter: number;
  private readonly clockDriftFactor: number; // Suggested factor for clock drift, e.g., 0.01 (1%)

  /**
   * Calculates the validity time for a lock, factoring in elapsed time and clock drift.
   * @param startTime The timestamp when the operation started.
   * @param ttl The requested time-to-live for the lock.
   * @returns The effective validity time in milliseconds.
   */
  private _calculateValidityTime(startTime: number, ttl: number): number {
    const elapsedTime = Date.now() - startTime;
    const drift = Math.ceil(this.clockDriftFactor * ttl);
    return ttl - elapsedTime - drift;
  }
  /**
   * Helper to acquire lock on a single Redis instance.
   * Uses a timeout significantly smaller than the lock's auto-release time (TTL).
   * The SET command `resource_name my_random_value NX PX 30000`
   */
  private async _acquireOnInstance(
    client: Redis,
    resource: string,
    value: string,
    ttl: number
  ): Promise<boolean> {
    try {
      const result = await client.set(resource, value, "PX", ttl, "NX");
      return result === "OK";
    } catch (error) {
      return false;
    }
  }

  /**
   * Releases a lock on a given resource using the provided value.
   * This is done by deleting the key on all instances if the value matches.
   * @param resource The resource identifier string.
   * @param value The unique value associated with the lock to be released.
   */
  public async release(resource: string, value: string): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const client of this.clients) {
      promises.push(client.releaseLockScript(resource, value).catch(() => 0));
    }
    await Promise.allSettled(promises);
  }

  /**
   * Closes all Redis connections.
   */
  public async quit(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.quit()));
  }

  /**
   * Extends a currently held lock.
   * The client should only consider the lock re-acquired if it was able to extend
   * the lock in the majority of instances and within the validity time.
   *
   * @param lock The AcquiredLock object to extend.
   * @param ttl The new time-to-live (in milliseconds) from now.
   * @returns A Promise that resolves to an updated AcquiredLock object if successful.
   */
  public async extend(lock: AcquiredLock, ttl: number): Promise<AcquiredLock> {
    let extendSuccessCount = 0;
    const startTime = Date.now();
    const promises: Promise<number>[] = [];
    for (const client of this.clients) {
      promises.push(
        client
          .extendLockScript(lock.resource, lock.value, ttl)
          .then((res: number) => (res === 1 ? 1 : 0))
          .catch(() => 0)
      );
    }
    const results = await Promise.all(promises);
    extendSuccessCount = results.reduce((a, b) => a + b, 0);

    const validityTime = this._calculateValidityTime(startTime, ttl);

    if (extendSuccessCount >= this.quorum && validityTime > 0) {
      return {
        resource: lock.resource,
        value: lock.value,
        validity: validityTime,
        expiration: Date.now() + validityTime,
        attempts: 1,
        release: () => this.release(lock.resource, lock.value),
      };
    } else {
      throw new LockExtendError(
        `Failed to extend lock for resource "${lock.resource}"`
      );
    }
  }

  /**
   * Initializes a new Redlock instance.
   * @param clientConfigs An array of ioredis client instances or connection options.
   * @param options Configuration options for Redlock.
   *        - retryCount: How many times to retry acquiring a lock (default: 3).
   *        - retryDelay: Base delay (ms) between retries (default: 200ms).
   *        - retryJitter: Max random jitter (ms) added to retryDelay (default: 100ms).
   *        - clockDriftFactor: Factor to account for clock drift (default: 0.01).
   *                          The effective lock validity will be reduced by ttl * clockDriftFactor.
   */
  constructor(
    clientConfigs: (Redis | RedisOptions)[],
    options: {
      retryCount?: number;
      retryDelay?: number;
      retryJitter?: number;
      clockDriftFactor?: number;
    } = {}
  ) {
    if (clientConfigs.length === 0) {
      throw new Error(
        "Redlock requires at least one Redis client configuration."
      );
    }

    this.clients = clientConfigs.map((configOrClient) => {
      const client =
        configOrClient instanceof Redis
          ? configOrClient
          : new Redis(configOrClient);

      // Always define both custom commands on every client.
      client.defineCommand("releaseLockScript", {
        numberOfKeys: 1,
        lua: UNLOCK_SCRIPT,
      });

      client.defineCommand("extendLockScript", {
        numberOfKeys: 1,
        lua: EXTEND_SCRIPT,
      });

      return client;
    });

    this.quorum = Math.floor(this.clients.length / 2) + 1;
    this.defaultRetryCount = options.retryCount ?? 3;
    this.defaultRetryDelay = options.retryDelay ?? 200;
    this.defaultRetryJitter = options.retryJitter ?? 100; // Add jitter to avoid thundering herd
    this.clockDriftFactor = options.clockDriftFactor ?? 0.01;

    if (this.clients.length < this.quorum) {
      console.warn(
        `Redlock Warning: The number of provided Redis instances (${this.clients.length}) is less than the calculated quorum (${this.quorum}). This setup is not fault-tolerant for locking.`
      );
    }
  }

  /**
   * Generates a unique string value for the lock.
   */
  private _createLockValue(): string {
    return randomBytes(20).toString("hex");
  }

  /**
   * Attempts to acquire a lock on a given resource.
   * @param resource The resource identifier string.
   * @param ttl The time-to-live (in milliseconds) for the lock.
   * @param options Optional settings for this specific lock attempt.
   *        - retryCount: Overrides the default retryCount.
   *        - retryDelay: Overrides the default retryDelay.
   *        - retryJitter: Overrides the default retryJitter.
   *        - lockValue: A specific value to use for the lock (for extensions or specific scenarios).
   * @returns A Promise that resolves to an AcquiredLock object if successful, or rejects.
   */
  public async acquire(
    resource: string,
    ttl: number,
    options: {
      retryCount?: number;
      retryDelay?: number;
      retryJitter?: number;
      lockValue?: string;
    } = {}
  ): Promise<AcquiredLock> {
    const retryCount = options.retryCount ?? this.defaultRetryCount;
    const baseRetryDelay = options.retryDelay ?? this.defaultRetryDelay;
    const retryJitter = options.retryJitter ?? this.defaultRetryJitter;

    let attempts = 0;

    const lockValue = options.lockValue || this._createLockValue();

    while (attempts <= retryCount) {
      attempts++;
      const startTime = Date.now();
      let locksAcquiredCount = 0;
      const promises: Promise<boolean>[] = [];

      // Step 2: Try to acquire the lock in all N instances sequentially (or in parallel).
      // Using parallel attempts here for potentially lower latency.
      // The original algorithm description says "sequentially", but also mentions
      // "ideally the client should try to send the SET commands to the N instances at the same time using multiplexing."
      for (const client of this.clients) {
        promises.push(
          this._acquireOnInstance(client, resource, lockValue, ttl)
        );
      }

      const results = await Promise.allSettled(promises);
      results.forEach((result) => {
        if (result.status === "fulfilled" && result.value) {
          locksAcquiredCount++;
        }
      });

      // Step 3: Compute elapsed time and check conditions.
      const validityTime = this._calculateValidityTime(startTime, ttl);

      // Check if lock acquired in majority and validity time is positive.
      if (locksAcquiredCount >= this.quorum && validityTime > 0) {
        // Step 4: Lock acquired.
        return {
          resource,
          value: lockValue,
          validity: validityTime,
          expiration: Date.now() + validityTime,
          attempts,
          release: () => this.release(resource, lockValue),
        };
      } else {
        // Step 5: Failed to acquire lock, unlock all instances.
        await this.release(resource, lockValue); // Best effort unlock

        if (attempts <= retryCount) {
          const jitter = Math.floor(Math.random() * retryJitter);
          await delay(baseRetryDelay + jitter);
        }
      }
    }

    throw new LockAcquisitionError(
      `Failed to acquire lock for resource "${resource}" after ${attempts} attempts.`,
      attempts
    );
  }
}
