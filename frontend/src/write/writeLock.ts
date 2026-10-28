/**
 * One write at a time across tabs of this origin, via the Web Locks API
 * (navigator.locks). Browser storage alone cannot do this: two tabs can both read
 * "no record" before either writes one. With the lock held, the tab re-reads
 * the record and writes its own before releasing control to the wallet.
 *
 * No Web Locks (very old browsers, some embedded webviews) means writes are
 * refused: there is no safe fallback. No dependency is involved.
 */
export const WRITE_LOCK_NAME = "vericourt.write.lock.v1";

export type Release = () => void;

export interface WriteLock {
  /** Resolves with a release function, or null if another holder has the lock. Never waits. */
  tryAcquire(): Promise<Release | null>;
}

interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean; mode?: "exclusive" }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

export function webLocks(nav: unknown = globalThis.navigator): WriteLock | null {
  let locks: LockManagerLike | undefined;
  try {
    locks = (nav as { locks?: LockManagerLike } | undefined)?.locks;
  } catch {
    return null;
  }
  if (!locks || typeof locks.request !== "function") return null;
  const manager = locks;
  return {
    tryAcquire() {
      return new Promise<Release | null>((resolve, reject) => {
        manager
          .request(WRITE_LOCK_NAME, { ifAvailable: true, mode: "exclusive" }, (lock) => {
            if (lock === null) {
              resolve(null);
              return;
            }
            // Hold the lock until release() is called (or the page goes away).
            return new Promise<void>((done) => resolve(() => done()));
          })
          .catch(reject);
      });
    },
  };
}

/** In-memory lock shared by "tabs" in tests. */
export function memoryLock(): WriteLock & { held: () => boolean } {
  let held = false;
  return {
    held: () => held,
    async tryAcquire() {
      if (held) return null;
      held = true;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          held = false;
        }
      };
    },
  };
}
