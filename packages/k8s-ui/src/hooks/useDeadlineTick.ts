import { useEffect, useState } from 'react'

// useDeadlineTick re-renders its caller once a moment in time has passed, and
// returns a counter that changes when it does. For a reading that lapses on
// its own (a controller's "still working" past its window) on a surface that
// is otherwise redrawn only when the data changes. No deadline, no timer.
export function useDeadlineTick(deadline: number | undefined): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (deadline === undefined) return
    // A little past the deadline, so the re-render reads it as passed.
    const wait = Math.min(Math.max(0, deadline - Date.now()) + 50, 2_147_000_000)
    const id = window.setTimeout(() => setTick((t) => t + 1), wait)
    return () => window.clearTimeout(id)
  }, [deadline])
  return tick
}
