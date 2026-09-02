
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useSessions } from './sessions-store'
export const SessionContext = createContext<string | undefined>(undefined)
export function SessionProvider({ children }: { children: ReactNode }) {
  const current = useSessions(s => s.current)
  return <SessionContext.Provider value={current}>{children}</SessionContext.Provider>
}
export function useSessionId(): string | undefined { return useContext(SessionContext) }
