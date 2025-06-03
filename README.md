# distrilock: Distributed Locks with Redis in TypeScript

A TypeScript implementation of the Redlock algorithm for distributed locks using Redis. This library helps manage resources in a mutually exclusive way across different processes or services.

It is based on the concepts outlined in the official Redis documentation: [Distributed Locks with Redis](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/).

## Features

*   Implements the Redlock algorithm for fault-tolerant distributed locking.
*   Supports multiple Redis instances for high availability.
*   Safe lock release using Lua scripts.
*   Automatic retry mechanism with jitter for lock acquisition.
*   Lock extension capability.
*   Clean, modern TypeScript API.

## Installation

Assuming the package is published as `distrilock` (as per `package.json`):

```bash
bun install distrilock ioredis
# or
npm install distrilock ioredis
# or
yarn add distrilock ioredis
```

This library requires `ioredis` as a peer dependency for Redis communication.

## Basic Usage

Here's a simple example of how to acquire and release a lock:

```typescript
import type { RedisOptions } from "ioredis";
import { Redlock, type AcquiredLock } from "distrilock"; // Assuming published as 'distrilock'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function example() {
  // Configuration for your Redis master instances
  const redisConfigs: RedisOptions[] = [
    { host: 'localhost', port: 7000 },
    { host: 'localhost', port: 7001 },
    { host: 'localhost', port: 7002 },
    // Add more Redis master instances if your setup requires (e.g., N=5)
  ];

  // Initialize Redlock
  // Ensure you have at least N/2 + 1 Redis master instances running.
  // These should be independent masters, not replicas, for Redlock's fault tolerance.
  const redlock = new Redlock(redisConfigs, {
    retryCount: 3,    // Number of times to retry locking (default: 3)
    retryDelay: 200,  // Base delay (ms) between retries (default: 200)
    retryJitter: 50,  // Max random jitter (ms) to add to retryDelay (default: 100)
    clockDriftFactor: 0.01, // Factor for clock drift (default: 0.01)
  });

  const resourceName = 'my-critical-resource';
  const lockTTL = 10000; // Lock time-to-live: 10 seconds

  let lock: AcquiredLock | null = null;
  try {
    console.log(`Attempting to acquire lock for "${resourceName}"...`);
    // Acquire the lock
    lock = await redlock.acquire(resourceName, lockTTL);
    console.log(`Lock acquired for "${resourceName}"! Effective validity: ${lock.validity}ms. Value: ${lock.value}`);

    // --- Perform critical work that requires the lock ---
    console.log("Performing critical work...");
    // Simulate work, ensuring it's less than lock.validity
    await delay(Math.min(5000, lock.validity / 2));
    console.log("Critical work finished.");

    // --- Optionally extend the lock if more time is needed ---
    /*
    if (lock) { // Check if lock is still held
      const newTTL = 15000; // Extend for another 15 seconds from now
      try {
        console.log("Attempting to extend lock...");
        lock = await redlock.extend(lock, newTTL);
        console.log(`Lock extended! New effective validity: ${lock.validity}ms.`);
        await delay(Math.min(7000, lock.validity / 2)); // Simulate more work
        console.log("Extended work finished.");
      } catch (extendError) {
        console.error(`Failed to extend lock: ${(extendError as Error).message}`);
        // Handle failure to extend: the original lock might still be valid or might have expired.
        // The application must decide how to proceed.
      }
    }
    */

  } catch (error) {
    console.error(`Failed to acquire lock or error during critical work: ${(error as Error).message}`);
    // Handle lock acquisition failure or errors during the critical section
  } finally {
    if (lock) {
      console.log(`Releasing lock for "${resourceName}"...`);
      try {
        await lock.release(); // Use the release method on the lock object
        console.log("Lock released.");
      } catch (releaseError) {
        console.error(`Error releasing lock: ${(releaseError as Error).message}`);
      }
    }
    // Close all Redis connections when Redlock is no longer needed
    await redlock.quit();
    console.log("Redlock connections closed.");
  }
}

example().catch(console.error);
```

## Understanding Redlock

It's highly recommended to understand the principles, guarantees, and trade-offs of the Redlock algorithm before using this library in production. Please refer to the official Redis documentation for a detailed explanation:

*   **[Distributed Locks with Redis](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/)**

Pay close attention to sections on safety, liveness, fault tolerance, and the discussion on clock drift and fencing tokens.

## API

(You would typically expand this section with more details about the `Redlock` class methods and options, and the `AcquiredLock` interface.)

### `new Redlock(clientConfigs, options?)`

*   `clientConfigs`: An array of `ioredis.Redis` instances or `ioredis.RedisOptions`.
*   `options`:
    *   `retryCount?`: `number` (default: 3)
    *   `retryDelay?`: `number` (ms, default: 200)
    *   `retryJitter?`: `number` (ms, default: 100)
    *   `clockDriftFactor?`: `number` (default: 0.01)

### `redlock.acquire(resource, ttl, options?)`

*   `resource`: `string` - Identifier for the resource to lock.
*   `ttl`: `number` (ms) - Time-to-live for the lock.
*   `options?`:
    *   `retryCount?`: `number`
    *   `retryDelay?`: `number`
    *   `retryJitter?`: `number`
    *   `lockValue?`: `string` (internal use, mainly for extensions)
*   Returns: `Promise<AcquiredLock>`

### `lock.release()`

*   Releases the acquired lock.
*   Returns: `Promise<void>`

### `redlock.extend(lock, ttl)`

*   `lock`: `AcquiredLock` - The currently held lock to extend.
*   `ttl`: `number` (ms) - The new time-to-live from the moment of extension.
*   Returns: `Promise<AcquiredLock>`

### `redlock.quit()`

*   Closes all underlying Redis connections.
*   Returns: `Promise<void>`

## Development & Testing

This project uses Bun for development and testing.

To install dependencies:
```bash
bun install
```

To run tests (requires Redis instances as defined in `docker-compose.yml`):
```bash
# Start Redis instances in another terminal
docker-compose up

# Run tests
bun test
```

## License

(Specify your license here, e.g., MIT)

---

This project was created using `bun init`. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.