import { open, readFile, unlink, stat } from 'node:fs/promises'

/**
 * Cross-process advisory file lock via O_EXCL (atomic create on POSIX and Windows NTFS) --
 * the same algorithm src/library/file-library.ts's own private acquireLock() already uses for
 * its index.json read-modify-write cycle, extracted here as a standalone utility so other
 * modules with the same shape of problem (src/promise/exception-store.ts, src/promise/
 * ledger-store.ts -- both plain read-modify-write cycles against a shared file, not a class)
 * can reuse the same tested approach instead of a second, driftable copy of it.
 *
 * Stale-lock recovery: a lock file older than 10s, or one whose recorded PID is no longer
 * alive, is treated as abandoned (a crashed process) and removed rather than blocking forever.
 * On a real timeout, proceeds anyway in degraded (unlocked) mode rather than hanging a CLI
 * command indefinitely -- the same tradeoff file-library.ts's own precedent makes.
 */
export async function acquireFileLock(lockPath: string, timeoutMs = 3_000): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs
  let delayMs = 10

  while (true) {
    try {
      const fh = await open(lockPath, 'wx')
      await fh.writeFile(String(process.pid))
      await fh.close()
      return async () => { await unlink(lockPath).catch(() => {}) }
    } catch (openErr) {
      // ENOENT means the lock file's own parent directory doesn't exist -- a caller bug (the
      // directory must be created before locking), not lock contention. Retrying forever would
      // busy-loop until the timeout with zero chance of succeeding -- fail fast and loud instead,
      // the same "surface it, don't spin" discipline this whole arc uses elsewhere. Only EEXIST
      // (the lock file is already held by someone) falls through to the contention-handling path
      // below.
      if ((openErr as NodeJS.ErrnoException)?.code === 'ENOENT') throw openErr
      try {
        const content = await readFile(lockPath, 'utf-8')
        const lockPid = parseInt(content.trim(), 10)
        const fileStat = await stat(lockPath)
        const ageMs = Date.now() - fileStat.mtimeMs

        if (ageMs > 10_000) {
          await unlink(lockPath).catch(() => {})
          continue
        }

        if (!isNaN(lockPid)) {
          try {
            process.kill(lockPid, 0) // throws ESRCH if PID is dead
          } catch {
            await unlink(lockPath).catch(() => {})
            continue
          }
        }
      } catch {
        // Lock file was removed between our read and check -- retry immediately
        continue
      }

      if (Date.now() > deadline) {
        return async () => {}
      }
      await new Promise<void>((r) => setTimeout(r, delayMs))
      delayMs = Math.min(delayMs * 1.5, 200)
    }
  }
}
