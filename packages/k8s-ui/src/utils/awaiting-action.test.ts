import { describe, expect, it } from 'vitest'
import { awaitingAction, awaitingNote, awaitsPromotion, rolloutHold, rolloutStall } from './awaiting-action'
import { isArgoRolloutRef } from './workload-rollout'

describe('awaitingAction', () => {
  it('reads what a node waits on a person for', () => {
    expect(awaitingAction({ awaiting: { label: 'Waiting for promotion', detail: 'Step 2 of 6' } })).toEqual({ label: 'Waiting for promotion', detail: 'Step 2 of 6' })
    expect(awaitingAction({ awaiting: { label: 'Waiting for promotion' } })).toEqual({ label: 'Waiting for promotion', detail: undefined })
  })

  it('is nothing without a label to show', () => {
    expect(awaitingAction(undefined)).toBeUndefined()
    expect(awaitingAction({})).toBeUndefined()
    expect(awaitingAction({ awaiting: true })).toBeUndefined()
    expect(awaitingAction({ awaiting: { detail: 'Step 2 of 6' } })).toBeUndefined()
    expect(awaitingAction({ awaiting: { label: '' } })).toBeUndefined()
  })

  it('says it in one line', () => {
    expect(awaitingNote({ label: 'Waiting for promotion', detail: 'Step 2 of 6' })).toBe('Waiting for promotion: Step 2 of 6')
    expect(awaitingNote({ label: 'Waiting for promotion' })).toBe('Waiting for promotion')
  })
})

describe('isArgoRolloutRef', () => {
  it('is the one kind Radar can promote, by group as well as kind', () => {
    expect(isArgoRolloutRef({ group: 'argoproj.io', kind: 'Rollout' })).toBe(true)
    expect(isArgoRolloutRef({ group: 'flagger.app', kind: 'Canary' })).toBe(false)
    expect(isArgoRolloutRef({ group: 'example.com', kind: 'Rollout' })).toBe(false)
    expect(isArgoRolloutRef({ kind: 'Rollout' })).toBe(false)
  })
})

describe('awaitsPromotion', () => {
  it('is the gate a promote answers, not a decision to promote or abort', () => {
    expect(awaitsPromotion('Waiting for promotion')).toBe(true)
    expect(awaitsPromotion('Analysis inconclusive')).toBe(false)
    expect(awaitsPromotion('Experiment inconclusive')).toBe(false)
    expect(awaitsPromotion(undefined)).toBe(false)
  })
})

describe('rolloutHold', () => {
  it('is a rollout under way that stands still without asking anyone', () => {
    expect(rolloutHold({ rollout: { phase: 'paused', active: true, manual: false, label: 'Rollout paused', detail: 'Step 4 (Pause: 30s)' } }))
      .toEqual({ label: 'Rollout paused', detail: 'Step 4 (Pause: 30s)', phase: 'paused' })
  })

  it('covers a revision that waits for its Pods to be deleted, without saying anyone must act', () => {
    expect(rolloutHold({ rollout: { phase: 'waiting', active: true, manual: true, label: 'Waiting for Pod restart', detail: 'OnDelete strategy · 0/2 updated' } }))
      .toEqual({ label: 'Waiting for Pod restart', detail: 'OnDelete strategy · 0/2 updated', phase: 'waiting' })
  })

  it('is not a request, a moving rollout, a stall or a settled workload', () => {
    expect(rolloutHold({ awaiting: { label: 'Waiting for promotion' }, rollout: { phase: 'paused', active: true, manual: true, label: 'Waiting for promotion' } })).toBeUndefined()
    expect(rolloutHold({ rollout: { phase: 'progressing', active: true, label: 'Rolling out' } })).toBeUndefined()
    expect(rolloutHold({ rollout: { phase: 'stalled', active: false, label: 'New revision cannot start' } })).toBeUndefined()
    expect(rolloutHold({ rollout: { phase: 'idle', active: false, label: 'Stable' } })).toBeUndefined()
    expect(rolloutHold(undefined)).toBeUndefined()
  })
})

describe('rolloutStall', () => {
  it('says why a rollout cannot go on', () => {
    expect(rolloutStall({ rollout: { phase: 'stalled', active: false, label: 'New revision cannot start', detail: 'CrashLoopBackOff · Pod web-2' } }))
      .toEqual({ label: 'New revision cannot start', detail: 'CrashLoopBackOff · Pod web-2' })
  })

  it('is nothing for a rollout that moves, waits or is settled', () => {
    expect(rolloutStall({ rollout: { phase: 'progressing', active: true, label: 'Rolling out' } })).toBeUndefined()
    expect(rolloutStall({ rollout: { phase: 'paused', active: true, manual: true, label: 'Waiting for promotion' } })).toBeUndefined()
    expect(rolloutStall({})).toBeUndefined()
  })
})
