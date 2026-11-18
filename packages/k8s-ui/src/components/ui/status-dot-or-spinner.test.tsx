import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusDotOrSpinner } from './status-tone'

// One slot, three readings. Mixing them up is silent: the wrong mark renders
// and nothing throws.
describe('StatusDotOrSpinner', () => {
  it('spins for work in motion', () => {
    const html = renderToStaticMarkup(<StatusDotOrSpinner tone="degraded" moving label="Rollout in progress" />)
    expect(html).toContain('animate-spin')
    expect(html).toContain('Rollout in progress')
  })

  it('shows a still hand for work parked until a person acts', () => {
    const html = renderToStaticMarkup(<StatusDotOrSpinner tone="degraded" awaiting />)
    expect(html).toContain('Waiting for a person')
    expect(html).not.toContain('animate-spin')
  })

  it('lets motion win when both are set', () => {
    const html = renderToStaticMarkup(<StatusDotOrSpinner tone="degraded" moving awaiting />)
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('Waiting for a person')
  })

  it('is a plain dot otherwise', () => {
    const html = renderToStaticMarkup(<StatusDotOrSpinner tone="healthy" />)
    expect(html).toContain('rounded-full')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('Waiting for a person')
  })
})
