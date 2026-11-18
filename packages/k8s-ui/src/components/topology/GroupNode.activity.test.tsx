import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider } from '@xyflow/react'
import { GroupNode } from './GroupNode'

// A collapsed namespace says what it holds that is at work or waiting on a
// person; without that, "2 in progress" under the graph points nowhere.
describe('GroupNode activity', () => {
  const render = (extra: Record<string, unknown>, displayLevel = 'chip') => {
    const props = {
      id: 'group-namespace-demo',
      width: 400,
      height: 120,
      data: {
        type: 'namespace', name: 'demo', nodeCount: 12, collapsed: true, displayLevel,
        onSetLevel: () => {}, kindCounts: { Deployment: 2 }, ...extra,
      },
    } as unknown as ComponentProps<typeof GroupNode>
    return renderToStaticMarkup(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>)
  }

  it('shows a spinner with the count of members at work and a hand with the count waiting', () => {
    const html = render({ changingCount: 2, awaitingCount: 1 })
    expect(html).toContain('animate-spin')
    expect(html).toContain('lucide-hand')
    expect(html).toMatch(/animate-spin[^]*?<\/svg>2</)
  })

  it('shows them on an expanded group too', () => {
    const html = render({ changingCount: 1 }, 'topology')
    expect(html).toContain('animate-spin')
  })

  it('shows nothing when nothing in the group is at work or waiting', () => {
    const html = render({})
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('lucide-hand')
  })
})
