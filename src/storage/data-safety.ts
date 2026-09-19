import type { StorageDiagnostics } from './diagnostics'
import { getSetting, setSetting } from './storage'

export const LAST_BACKUP_SETTING_KEY = 'dataSafety:lastBackup'
export const BACKUP_STALE_AFTER_DAYS = 14

export type LastBackupRecord = {
  completedAt: number
  fileName: string
}

export type DataSafetyStatus = {
  quotaRatio?: number
  quotaLevel: 'unknown' | 'ok' | 'warning' | 'critical'
  backupState: 'never' | 'fresh' | 'stale'
  backupAgeDays?: number
  protectedFromEviction: boolean | undefined
}

function isLastBackupRecord(value: unknown): value is LastBackupRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<LastBackupRecord>
  return Number.isFinite(record.completedAt) && Number(record.completedAt) > 0
    && typeof record.fileName === 'string' && record.fileName.length > 0
}

export async function getLastBackupRecord(): Promise<LastBackupRecord | undefined> {
  const value = await getSetting(LAST_BACKUP_SETTING_KEY)
  return isLastBackupRecord(value) ? value : undefined
}

export async function recordBackupCompleted(fileName: string, completedAt = Date.now()): Promise<LastBackupRecord> {
  const record = { completedAt, fileName }
  await setSetting(LAST_BACKUP_SETTING_KEY, record)
  return record
}

export function deriveDataSafetyStatus(
  diagnostics: StorageDiagnostics,
  lastBackup: LastBackupRecord | undefined,
  now = Date.now(),
): DataSafetyStatus {
  const usage = diagnostics.originUsageBytes
  const quota = diagnostics.originQuotaBytes
  const quotaRatio = typeof usage === 'number' && typeof quota === 'number' && quota > 0
    ? Math.max(0, usage / quota)
    : undefined
  const quotaLevel = quotaRatio === undefined
    ? 'unknown'
    : quotaRatio >= 0.9
      ? 'critical'
      : quotaRatio >= 0.75
        ? 'warning'
        : 'ok'

  const backupAgeDays = lastBackup
    ? Math.max(0, Math.floor((now - lastBackup.completedAt) / 86_400_000))
    : undefined
  const backupState = !lastBackup
    ? 'never'
    : (backupAgeDays ?? 0) > BACKUP_STALE_AFTER_DAYS
      ? 'stale'
      : 'fresh'

  return {
    ...(quotaRatio !== undefined ? { quotaRatio } : {}),
    quotaLevel,
    backupState,
    ...(backupAgeDays !== undefined ? { backupAgeDays } : {}),
    protectedFromEviction: diagnostics.storagePersistent,
  }
}
