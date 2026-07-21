import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '../../../src/utils/file-lock.js'

let scratchDir: string

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'kairos-file-lock-test-'))
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('acquireFileLock', () => {
  it('acquires and releases a lock on an uncontended path', async () => {
    const lockPath = join(scratchDir, 'a.lock')
    const release = await acquireFileLock(lockPath)
    expect(await readFile(lockPath, 'utf-8')).toBe(String(process.pid))
    await release()
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow()
  })

  it('a second acquire waits until the first is released, never runs concurrently', async () => {
    const lockPath = join(scratchDir, 'b.lock')
    const order: string[] = []

    const release1 = await acquireFileLock(lockPath)
    const second = (async () => {
      const release2 = await acquireFileLock(lockPath)
      order.push('second-acquired')
      await release2()
    })()

    await new Promise(r => setTimeout(r, 30))
    order.push('first-still-held')
    await release1()
    await second
    expect(order).toEqual(['first-still-held', 'second-acquired'])
  })

  it('removes a stale lock (old mtime) rather than waiting out the full timeout', async () => {
    const lockPath = join(scratchDir, 'stale.lock')
    await writeFile(lockPath, '999999999') // a pid that (almost certainly) does not exist
    const old = new Date(Date.now() - 20_000)
    await utimes(lockPath, old, old)

    const start = Date.now()
    const release = await acquireFileLock(lockPath, 3_000)
    expect(Date.now() - start).toBeLessThan(2_000)
    await release()
  })

  it('throws immediately (not a busy-loop to the timeout) when the parent directory does not exist', async () => {
    const lockPath = join(scratchDir, 'missing-dir', 'x.lock')
    const start = Date.now()
    await expect(acquireFileLock(lockPath, 3_000)).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(500)
  })
})
