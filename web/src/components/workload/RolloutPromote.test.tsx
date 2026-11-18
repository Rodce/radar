// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RolloutPromoteButton, RolloutPromoteProvider } from './RolloutPromote'
import { setApiBase } from '../../api/config'

// The button sits inside things that answer clicks and keys (a graph node, a
// table row); the dialog it opens must not be one of their children, and a
// sent promote must not be sendable twice.

let host: HTMLDivElement
let root: Root
let client: QueryClient
let calls: { url: string; method: string; body?: string }[]
let canPromote: boolean
let live: Record<string, unknown>

// A canary on its untimed pause at step 2, with an analysis at step 3.
const waiting = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Rollout',
  metadata: { name: 'web', namespace: 'apps', generation: 3 },
  spec: { replicas: 4, strategy: { canary: { steps: [{ setWeight: 25 }, { pause: {} }, { analysis: { templates: [{ templateName: 'smoke' }] } }] } } },
  status: { observedGeneration: '3', phase: 'Paused', currentStepIndex: 1, pauseConditions: [{ reason: 'CanaryPauseStep', startTime: '2026-11-18T10:00:00Z' }], replicas: 4, updatedReplicas: 1, readyReplicas: 4, availableReplicas: 4 },
}
// The same Rollout once someone else promoted it: running the analysis.
const movedOn = { ...waiting, status: { ...waiting.status, phase: 'Progressing', currentStepIndex: 2, pauseConditions: [] } }
// A canary with a second untimed pause, waiting at it after someone else
// promoted the first one: still "Waiting for promotion", not the same pause.
const twoPauses = { ...waiting.spec.strategy.canary, steps: [{ setWeight: 25 }, { pause: {} }, { setWeight: 50 }, { pause: {} }] }
const atLaterPause = {
  ...waiting,
  spec: { ...waiting.spec, strategy: { canary: twoPauses } },
  status: { ...waiting.status, currentStepIndex: 3, pauseConditions: [{ reason: 'CanaryPauseStep', startTime: '2026-11-18T10:05:00Z' }] },
}
const firstPause = 'step:1@2026-11-18T10:00:00Z'
const onRowClick = vi.fn()
const onRowKey = vi.fn()

async function render(gate?: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RolloutPromoteProvider>
          <div data-testid="row" onClick={onRowClick} onKeyDown={onRowKey}>
            <RolloutPromoteButton namespace="apps" name="web" waitingFor="Step 2 (Pause: until promoted) · 1/4 updated" gate={gate} />
          </div>
        </RolloutPromoteProvider>
      </QueryClientProvider>,
    )
  })
  await flush()
}

async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function button(label: RegExp): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement | undefined
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setApiBase('/api')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  calls = []
  canPromote = true
  live = waiting
  onRowClick.mockClear()
  onRowKey.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.endsWith('/capabilities')) {
      return Response.json({ abort: true, retry: true, promote: canPromote, promoteFull: true, skipStep: true, rollback: true, restart: true, strategy: 'canary', terminating: false })
    }
    if (url.startsWith('/api/resources/rollouts/apps/web')) {
      return Response.json({ resource: live })
    }
    return Response.json({ message: 'promote sent' })
  }))
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
  vi.unstubAllGlobals()
})

it('offers nothing to someone who may not promote', async () => {
  canPromote = false
  await render()
  expect(button(/Promote/)).toBeUndefined()
})

it('asks first, outside the row, and promotes once', async () => {
  await render()
  const promote = button(/^Promote$/)!
  expect(promote.getAttribute('aria-label')).toBe('Promote apps/web')

  await act(async () => { promote.click() })
  expect(onRowClick).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Promote web?')
  expect(dialog.textContent).toContain('Step 2 (Pause: until promoted)')
  expect(host.querySelector('[data-testid="row"]')!.contains(dialog)).toBe(false)

  const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Promote')!
  await act(async () => { confirm.click() })
  await flush()
  expect(calls.map((c) => `${c.method} ${c.url}`).filter((c) => !c.endsWith('/capabilities'))).toEqual([
    'GET /api/resources/rollouts/apps/web?group=argoproj.io',
    'POST /api/rollouts/apps/web/promote',
  ])
  expect(onRowClick).not.toHaveBeenCalled()

  // The dialog closes (after its exit animation) and the button can't open it
  // again.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  const sent = button(/Promote sent/)!
  expect(sent.disabled).toBe(true)
  await act(async () => { sent.click() })
  await flush()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

// The mark the button sits beside can be half a minute old. If the Rollout
// has moved on since, a promote would skip the step it is on now (here, the
// analysis), so nothing is sent.
it('sends nothing once the Rollout has moved on', async () => {
  await render()
  live = movedOn
  await act(async () => { button(/^Promote$/)!.click() })
  const dialog = document.querySelector('[role="dialog"]')!
  const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Promote')!
  await act(async () => { confirm.click() })
  await flush()
  expect(calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/resources/rollouts/apps/web'))).toBe(true)
  expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(button(/^Promote$/)!.disabled).toBe(false)
})

async function confirmPromote() {
  await act(async () => { button(/^Promote$/)!.click() })
  const dialog = document.querySelector('[role="dialog"]')!
  const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Promote')!
  await act(async () => { confirm.click() })
  await flush()
}

// The tree and the list name the pause they showed, and the server refuses
// the promote once the Rollout no longer waits there.
it('sends the pause it was confirmed for', async () => {
  await render(firstPause)
  await confirmPromote()
  const posts = calls.filter((c) => c.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0].body ?? '{}')).toEqual({ gate: firstPause })
})

// Someone else promoted the pause shown and the Rollout now waits at the next
// untimed one: a promote would clear a pause nobody here was shown.
it('sends nothing when the Rollout waits at another pause', async () => {
  await render(firstPause)
  live = atLaterPause
  await confirmPromote()
  expect(calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/resources/rollouts/apps/web'))).toBe(true)
  expect(calls.filter((c) => c.method === 'POST')).toEqual([])
})

it('keeps its keys to itself', async () => {
  await render()
  const promote = button(/^Promote$/)!
  await act(async () => { promote.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(onRowKey).not.toHaveBeenCalled()
})
