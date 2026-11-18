// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNow } from './useNow'

// A tree with many cards at work reads one clock: one interval for all of
// them, the same time on every card, and no interval once they settle.

function Clock({ active, intervalMs }: { active: boolean; intervalMs?: number }) {
  return <span>{useNow(active, intervalMs)}</span>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('runs one interval for every active reader, and none once they are gone', async () => {
  const setInterval = vi.spyOn(window, 'setInterval')
  const clearInterval = vi.spyOn(window, 'clearInterval')
  const host = document.createElement('div')
  const root = createRoot(host)
  const readers = Array.from({ length: 50 }, (_, i) => <Clock key={i} active />)

  await act(async () => { root.render(<>{readers}<Clock active={false} /></>) })
  expect(setInterval).toHaveBeenCalledTimes(1)
  const start = Number(host.querySelector('span')!.textContent)

  await act(async () => { vi.advanceTimersByTime(1000) })
  const shown = Array.from(host.querySelectorAll('span')).slice(0, 50).map((span) => Number(span.textContent))
  expect(new Set(shown)).toEqual(new Set([start + 1000]))

  await act(async () => { root.unmount() })
  expect(clearInterval).toHaveBeenCalledTimes(1)
})

it('keeps a slower clock of its own', async () => {
  const setInterval = vi.spyOn(window, 'setInterval')
  const host = document.createElement('div')
  const root = createRoot(host)

  await act(async () => { root.render(<><Clock active /><Clock active intervalMs={5000} /></>) })
  expect(setInterval.mock.calls.map((call) => call[1])).toEqual([1000, 5000])
  const [fast, slow] = Array.from(host.querySelectorAll('span')).map((span) => Number(span.textContent))

  await act(async () => { vi.advanceTimersByTime(1000) })
  const [fastAfter, slowAfter] = Array.from(host.querySelectorAll('span')).map((span) => Number(span.textContent))
  expect(fastAfter).toBe(fast + 1000)
  expect(slowAfter).toBe(slow)

  await act(async () => { root.unmount() })
})
