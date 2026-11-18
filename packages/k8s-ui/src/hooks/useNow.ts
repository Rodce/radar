import { useCallback, useSyncExternalStore } from 'react'

// One clock per period, shared by every component that reads it. A graph with
// a few hundred cards at work keeps one interval, not a few hundred, and its
// cards re-render together in one batch each tick rather than each on a beat
// of its own. The clock runs only while someone reads it.
interface Clock {
  now: number
  readers: Set<() => void>
  timer?: number
}

const clocks = new Map<number, Clock>()

function clockFor(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs)
  if (!clock) {
    clock = { now: Date.now(), readers: new Set() }
    clocks.set(intervalMs, clock)
  }
  return clock
}

function subscribe(intervalMs: number, reader: () => void): () => void {
  const clock = clockFor(intervalMs)
  clock.readers.add(reader)
  if (clock.timer === undefined) {
    // An idle clock still holds the time it stopped at.
    clock.now = Date.now()
    clock.timer = window.setInterval(() => {
      clock.now = Date.now()
      for (const read of clock.readers) read()
    }, intervalMs)
  }
  return () => {
    clock.readers.delete(reader)
    if (clock.readers.size === 0 && clock.timer !== undefined) {
      window.clearInterval(clock.timer)
      clock.timer = undefined
    }
  }
}

const idle = () => () => {}

// useNow re-renders its caller once a period while active (every second by
// default), for a ticking elapsed time ("Upgrading · 18s"). Inactive, it
// holds still and costs nothing.
export function useNow(active: boolean, intervalMs = 1000): number {
  const subscribeToClock = useCallback((reader: () => void) => subscribe(intervalMs, reader), [intervalMs])
  // A clock nobody has read for a while catches up on the next read, so the
  // first frame of a newly active caller is no older than a running clock's.
  const read = useCallback(() => {
    const clock = clockFor(intervalMs)
    if (clock.timer === undefined && Date.now() - clock.now >= intervalMs) clock.now = Date.now()
    return clock.now
  }, [intervalMs])
  return useSyncExternalStore(active ? subscribeToClock : idle, read, read)
}
