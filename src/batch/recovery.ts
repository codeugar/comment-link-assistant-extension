export const BATCH_RECOVERY_ALARM = 'comment-link-assistant.batch-recovery';

export async function armBatchRecoveryAlarm(): Promise<void> {
  await chrome.alarms.create(BATCH_RECOVERY_ALARM, {
    delayInMinutes: 0.5,
    periodInMinutes: 0.5,
  });
}
