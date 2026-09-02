
import { useSyncExternalStore } from 'react'
export type Store<S> = {
  getSnapshot: () => S
  subscribe: (fn: () => void) => () => void
  actions: Record<string, (...args: any[]) => void>
}
export function createStore<S>(init: () => S, reducers: Record<string, (state: S, ...args: any[]) => S>): Store<S> {
  let state: S = init()
  const subs = new Set<() => void>()
  const actions: Record<string, (...args: any[]) => void> = {}
  for (const k in reducers) {
    const fn = reducers[k]
    actions[k] = (...args: any[]) => { state = fn(state, ...args); subs.forEach(f => f()) }
  }
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    actions,
  }
}
export function useStore<S, T>(store: { getSnapshot: () => S; subscribe: (fn: () => void) => () => void }, selector: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
}
