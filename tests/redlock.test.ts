import {
  expect,
  test,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  type Mock,
} from "bun:test";
import Redis from "ioredis";
import type { RedisOptions } from "ioredis";
import { Redlock } from "../src";
import type { AcquiredLock } from "../src";
import { spyOn } from "bun:test";

const redisTestConfigs: RedisOptions[] = [
  { host: "localhost", port: 7000, connectTimeout: 1000, commandTimeout: 500 },
  { host: "localhost", port: 7001, connectTimeout: 1000, commandTimeout: 500 },
  { host: "localhost", port: 7002, connectTimeout: 1000, commandTimeout: 500 },
];

const createRawClients = (configs: RedisOptions[]): Redis[] => {
  return configs.map((config) => new Redis(config));
};

const clearRedisInstances = async (clients: Redis[]) => {
  for (const client of clients) {
    try {
      await client.flushdb();
    } catch (e) {
      console.warn(
        `Could not flushdb for a redis instance: ${(e as Error).message}`
      );
    }
  }
};

describe("Redlock Distributed Lock", () => {
  let redlock: Redlock;
  let rawClients: Redis[];
  let spies: Mock<any>[] = [];

  beforeAll(() => {
    rawClients = createRawClients(redisTestConfigs);
  });

  beforeEach(async () => {
    redlock = new Redlock(rawClients, {
      retryCount: 2,
      retryDelay: 50,
      retryJitter: 20,
      clockDriftFactor: 0.01,
    });
    await clearRedisInstances(rawClients);
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
    spies = [];
  });

  afterAll(async () => {
    if (redlock) {
      await redlock.quit();
    }
    for (const client of rawClients) {
      client.disconnect();
    }
  });

  test("should acquire and release a lock successfully", async () => {
    const resource = "test-resource-1";
    const ttl = 1000;

    const lock = await redlock.acquire(resource, ttl);
    expect(lock).toBeDefined();
    expect(lock.resource).toBe(resource);
    expect(lock.validity).toBeGreaterThan(0);
    expect(lock.validity).toBeLessThanOrEqual(ttl);
    expect(lock.attempts).toBe(1);

    let lockCount = 0;
    for (const client of rawClients) {
      if ((await client.get(resource)) === lock.value) {
        lockCount++;
      }
    }
    expect(lockCount).toBeGreaterThanOrEqual(redlock["quorum"]);

    await lock.release();

    let releasedCount = 0;
    for (const client of rawClients) {
      if ((await client.get(resource)) === null) {
        releasedCount++;
      }
    }
    const lockAgain = await redlock.acquire(resource, ttl);
    expect(lockAgain).toBeDefined();
    await lockAgain.release();
  });

  test("acquire should fail if quorum is NOT met (e.g., only 1 of 3 succeeds)", async () => {
    const resource = "quorum-fail-resource";
    const ttl = 1000;
    const quorum = redlock["quorum"];
    expect(rawClients.length).toBe(3);
    expect(quorum).toBe(2);

    const spy1 = rawClients[1]
      ? spyOn(rawClients[1], "set").mockResolvedValue(null)
      : null;
    if (spy1) spies.push(spy1);
    const spy2 = rawClients[2]
      ? spyOn(rawClients[2], "set").mockResolvedValue(null)
      : null;
    if (spy2) spies.push(spy2);

    await expect(redlock.acquire(resource, ttl)).rejects.toThrow();

    expect(spy1).toHaveBeenCalledTimes(3);
    expect(spy2).toHaveBeenCalledTimes(3);

    if (rawClients[0] && typeof rawClients[0].get === "function") {
      const lockOnClient0 = await rawClients[0].get(resource);
      expect(lockOnClient0).toBeNull();
    }
  });

  test("acquire should succeed if quorum IS met (e.g., 2 of 3 succeed)", async () => {
    const resource = "quorum-success-resource";
    const ttl = 1000;
    const quorum = redlock["quorum"];
    expect(quorum).toBe(2);

    const spy2 = rawClients[2]
      ? spyOn(rawClients[2], "set").mockResolvedValue(null)
      : null;
    if (spy2) spies.push(spy2);

    let lock: AcquiredLock | null = null;
    try {
      lock = await redlock.acquire(resource, ttl);
      expect(lock).toBeDefined();
      expect(lock.resource).toBe(resource);

      expect(spy2).toHaveBeenCalledTimes(1);

      let successCount = 0;
      if (
        rawClients[0] &&
        typeof rawClients[0].get === "function" &&
        (await rawClients[0].get(resource)) === lock.value
      )
        successCount++;
      if (
        rawClients[1] &&
        typeof rawClients[1].get === "function" &&
        (await rawClients[1].get(resource)) === lock.value
      )
        successCount++;
      expect(successCount).toBe(quorum);

      if (rawClients[2] && typeof rawClients[2].get === "function") {
        expect(await rawClients[2].get(resource)).toBeNull();
      }
    } finally {
      if (lock) {
        await lock.release();
      }
    }
  });

  test("acquire should succeed if quorum is met despite one instance throwing error", async () => {
    const resource = "instance-error-acquire";
    const ttl = 1000;
    const quorum = redlock["quorum"];
    expect(quorum).toBe(2);

    const spyError = rawClients[2]
      ? spyOn(rawClients[2], "set").mockImplementation(async () => {
          throw new Error("Simulated Redis connection error");
        })
      : null;
    if (spyError) spies.push(spyError);

    let spyReleaseAttempt;
    if (rawClients[2]) {
      spyReleaseAttempt = spyOn(
        rawClients[2],
        "releaseLockScript"
      ).mockResolvedValue(0);
      spies.push(spyReleaseAttempt);
    }

    let lock: AcquiredLock | null = null;
    try {
      lock = await redlock.acquire(resource, ttl);
      expect(lock).toBeDefined();

      if (rawClients[0] && typeof rawClients[0].get === "function") {
        expect(await rawClients[0].get(resource)).toBe(lock.value);
      }
      if (rawClients[1] && typeof rawClients[1].get === "function") {
        expect(await rawClients[1].get(resource)).toBe(lock.value);
      }

      expect(spyError).toHaveBeenCalledTimes(1);
    } finally {
      if (lock) {
        await lock.release();
        if (spyReleaseAttempt) expect(spyReleaseAttempt).toHaveBeenCalled();
      }
    }
  });

  test("lock.release should attempt release on all instances even if some fail", async () => {
    const resource = "release-some-fail";
    const ttl = 500;

    const lock = await redlock.acquire(resource, ttl);
    expect(lock).toBeDefined();

    for (const client of rawClients) {
      expect(await client.get(resource)).toBe(lock.value);
    }

    let spyReleaseFail, spyReleaseSuccess0, spyReleaseSuccess2;
    if (rawClients[1]) {
      spyReleaseFail = spyOn(
        rawClients[1],
        "releaseLockScript"
      ).mockImplementation(async () => {
        throw new Error("Simulated release failure");
      });
      spies.push(spyReleaseFail);
    }

    if (rawClients[0]) {
      spyReleaseSuccess0 = spyOn(
        rawClients[0],
        "releaseLockScript"
      ).mockImplementation(async (resource: string, value: string) => {
        await rawClients[0]!.del(resource);
        return 1;
      });
      spies.push(spyReleaseSuccess0);
    }
    if (rawClients[2]) {
      spyReleaseSuccess2 = spyOn(
        rawClients[2],
        "releaseLockScript"
      ).mockImplementation(async (resource: string, value: string) => {
        await rawClients[2]!.del(resource);
        return 1;
      });
      spies.push(spyReleaseSuccess2);
    }

    await expect(lock.release()).resolves.toBeUndefined();

    expect(spyReleaseSuccess0).toHaveBeenCalledWith(resource, lock.value);
    expect(spyReleaseFail).toHaveBeenCalledWith(resource, lock.value);
    expect(spyReleaseSuccess2).toHaveBeenCalledWith(resource, lock.value);

    if (rawClients[0] && typeof rawClients[0].get === "function") {
      expect(await rawClients[0].get(resource)).toBeNull();
    }
    if (rawClients[1] && typeof rawClients[1].get === "function") {
      expect(await rawClients[1].get(resource)).toBe(lock.value);
    }
    if (rawClients[2] && typeof rawClients[2].get === "function") {
      expect(await rawClients[2].get(resource)).toBeNull();
    }
  });

  test("extend should succeed if quorum is met despite some instance failures", async () => {
    const resource = "extend-some-fail";
    const initialTtl = 300;
    const extendTtl = 1000;

    let lock = await redlock.acquire(resource, initialTtl);
    expect(lock).toBeDefined();
    const originalValue = lock.value;

    let spyExtendFail, spyExtendSuccess0;
    if (rawClients[2]) {
      spyExtendFail = spyOn(
        rawClients[2],
        "extendLockScript"
      ).mockResolvedValue(0);
      spies.push(spyExtendFail);
    }

    if (rawClients[0]) {
      spyExtendSuccess0 = spyOn(
        rawClients[0],
        "extendLockScript"
      ).mockImplementation(
        async (resource: string, value: string, ttl: number) => {
          const storedValue = await rawClients[0]!.get(resource);
          if (storedValue === value) {
            await rawClients[0]!.pexpire(resource, ttl);
            return 1;
          }
          return 0;
        }
      );
      spies.push(spyExtendSuccess0);
    }

    const spyExtendSuccess1 = spyOn(
      rawClients[1]!,
      "extendLockScript"
    ).mockImplementation(
      async (resource: string, value: string, ttl: number) => {
        await rawClients[1]!.pexpire(resource, ttl);
        return 1;
      }
    );
    spies.push(spyExtendSuccess1);

    await Bun.sleep(initialTtl / 3);

    lock = await redlock.extend(lock, extendTtl);
    expect(lock).toBeDefined();
    expect(lock.value).toBe(originalValue);
    expect(lock.validity).toBeGreaterThan(0);
    expect(lock.validity).toBeLessThanOrEqual(extendTtl);

    expect(spyExtendSuccess0).toHaveBeenCalledWith(
      resource,
      originalValue,
      extendTtl
    );
    expect(spyExtendSuccess1).toHaveBeenCalledWith(
      resource,
      originalValue,
      extendTtl
    );
    expect(spyExtendFail).toHaveBeenCalledWith(
      resource,
      originalValue,
      extendTtl
    );

    if (rawClients[0] && typeof rawClients[0].pttl === "function") {
      expect(await rawClients[0].pttl(resource)).toBeGreaterThan(
        extendTtl - 300
      );
    }
    if (rawClients[1] && typeof rawClients[1].pttl === "function") {
      expect(await rawClients[1].pttl(resource)).toBeGreaterThan(
        extendTtl - 300
      );
    }
    if (rawClients[2] && typeof rawClients[2].pttl === "function") {
      const pttlClient2 = await rawClients[2].pttl(resource);
      expect(pttlClient2).toBeLessThanOrEqual(initialTtl);
      expect(pttlClient2).not.toBeGreaterThan(initialTtl);
    }

    await lock.release();
  });

  test("quit should call quit on all underlying clients", async () => {
    const testClients = createRawClients(redisTestConfigs);
    const localRedlock = new Redlock(testClients, {});

    const spiesQuit = testClients.map((client) =>
      spyOn(client, "quit").mockResolvedValue("OK")
    );
    spies.push(...spiesQuit);

    await localRedlock.quit();

    spiesQuit.forEach((spy) => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  test("lock should expire after TTL", async () => {
    const resource = "ttl-resource";
    const ttl = 200;

    const lock = await redlock.acquire(resource, ttl);
    expect(lock).toBeDefined();

    await Bun.sleep(lock.validity + 100);

    const lockAgain = await redlock.acquire(resource, ttl);
    expect(lockAgain).toBeDefined();
    expect(lockAgain.value).not.toBe(lock.value);

    await lockAgain.release();
  });

  test("should extend a held lock successfully", async () => {
    const resource = "extend-resource";
    const initialTtl = 300;

    for (const client of rawClients) {
      client.extendLockScript = async (
        resource: string,
        value: string,
        ttl: number
      ) => {
        const stored = await client.get(resource);
        if (stored === value) {
          await client.pexpire(resource, ttl);
          return 1;
        }
        return 0;
      };
    }

    let lock = await redlock.acquire(resource, initialTtl);
    expect(lock).toBeDefined();
    const originalValue = lock.value;
    const originalExpiration = lock.expiration;
    const originalValidity = lock.validity;

    expect(originalValidity).toBeGreaterThan(0);

    await Bun.sleep(originalValidity / 3);

    const extendTtl = 1000;
    lock = await redlock.extend(lock, extendTtl);

    expect(lock).toBeDefined();
    expect(lock.resource).toBe(resource);
    expect(lock.value).toBe(originalValue);
    expect(lock.validity).toBeGreaterThan(0);
    expect(lock.validity).toBeLessThanOrEqual(extendTtl);
    expect(lock.expiration).toBeGreaterThan(originalExpiration);

    let lockCount = 0;
    for (const client of rawClients) {
      if ((await client.get(resource)) === originalValue) {
        lockCount++;
      }
    }
    expect(lockCount).toBeGreaterThanOrEqual(redlock["quorum"]);

    await lock.release();
  });

  test("extending a lock not held (or expired) should fail", async () => {
    const resource = "extend-fail-resource";
    const ttl = 200;

    const fakeLock: AcquiredLock = {
      resource,
      value: "fake-value-that-was-never-set",
      validity: 100,
      expiration: Date.now() + 100,
      attempts: 1,
      release: async () => {},
    };

    await expect(redlock.extend(fakeLock, ttl)).rejects.toThrow();

    const realLock = await redlock.acquire(resource, 100);
    await Bun.sleep(300);

    await expect(redlock.extend(realLock, ttl)).rejects.toThrow();
  });

  test("lock validity should be less than TTL due to acquisition time and drift", async () => {
    const resource = "validity-check-resource";
    const ttl = 5000;

    const lock = await redlock.acquire(resource, ttl);

    expect(lock).toBeDefined();
    expect(lock.validity).toBeLessThanOrEqual(ttl);
    expect(lock.validity).toBeGreaterThan(0);
    expect(lock.validity).toBeLessThanOrEqual(
      ttl - Math.ceil(redlock["clockDriftFactor"] * ttl)
    );

    await lock.release();
  });

  test("should retry acquiring lock if initially fails (complex to perfectly simulate contention for retry)", async () => {
    const resource = "retry-resource";
    const ttl = 500;

    const blockerLock = await redlock.acquire(resource, ttl + 500);
    expect(blockerLock).toBeDefined();

    const redlockRetry = new Redlock(redisTestConfigs, {
      retryCount: 3,
      retryDelay: 100,
      retryJitter: 20,
    });

    let successfulAcquisition = false;
    let attemptedLock: AcquiredLock | null = null;

    const acquirePromise = redlockRetry
      .acquire(resource, ttl)
      .then((lock) => {
        successfulAcquisition = true;
        attemptedLock = lock;
      })
      .catch(() => {
        successfulAcquisition = false;
      });

    await Bun.sleep(100);
    await blockerLock.release();

    await acquirePromise;

    expect(successfulAcquisition).toBe(true);
    expect(attemptedLock).toBeDefined();
    if (attemptedLock) {
      expect((attemptedLock as AcquiredLock).attempts).toBeGreaterThanOrEqual(
        1
      );
      await (attemptedLock as AcquiredLock).release();
    }
    await redlockRetry.quit();
  });
});
