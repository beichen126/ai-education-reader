
import type { ComponentType, ReactNode } from 'react'
import type { SessionsState } from './sessions-store'
export type PropsRuntime<S extends string> = {
  SessionProvider: ComponentType<{ children: ReactNode }>
  useSessions: <T>(sel: (s: SessionsState) => T) => T
}
export type PropsRenderSlots<K extends string> = { renderSlot: (key: K, owner?: any) => ReactNode }
export type PropsStore<S> = { useStore: <T>(sel: (s: S) => T) => T; actions: Record<string, (...a: any[]) => void> }
export type PropsLocale<NS extends string> = { t: (key: string, opts?: any) => string }
