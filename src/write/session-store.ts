import { comparablePageUrl } from '@/runtime/page-commands';
import { z } from 'zod';
import { type WriteSession, writeSessionSchema } from './types';

export const WRITE_SESSION_STORAGE_KEY =
  'comment-link-assistant.write-sessions';

// One session per tab; a handful of open tabs at once is the realistic
// ceiling, and stale entries fall off the back on write.
const MAX_WRITE_SESSIONS = 20;

const writeSessionsSchema = z.record(z.string(), writeSessionSchema);

type WriteSessionsMap = Record<string, WriteSession>;

async function readAll(): Promise<WriteSessionsMap> {
  const stored = await chrome.storage.session.get(WRITE_SESSION_STORAGE_KEY);
  const parsed = writeSessionsSchema.safeParse(
    stored[WRITE_SESSION_STORAGE_KEY]
  );
  return parsed.success ? parsed.data : {};
}

async function writeAll(map: WriteSessionsMap): Promise<void> {
  const entries = Object.entries(map)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_WRITE_SESSIONS);
  await chrome.storage.session.set({
    [WRITE_SESSION_STORAGE_KEY]: writeSessionsSchema.parse(
      Object.fromEntries(entries)
    ),
  });
}

export async function getWriteSession(
  tabId: number
): Promise<WriteSession | null> {
  const all = await readAll();
  return all[String(tabId)] ?? null;
}

export async function setWriteSession(
  session: WriteSession
): Promise<WriteSession> {
  const parsed = writeSessionSchema.parse(session);
  const all = await readAll();
  await writeAll({ ...all, [String(parsed.tabId)]: parsed });
  return parsed;
}

export async function deleteWriteSession(tabId: number): Promise<void> {
  const all = await readAll();
  if (!(String(tabId) in all)) return;
  const next = { ...all };
  delete next[String(tabId)];
  await writeAll(next);
}

export async function listWriteSessions(): Promise<WriteSession[]> {
  return Object.values(await readAll());
}

/**
 * True once the tab has navigated away from the page the session was created
 * for. The background treats a stale session as gone rather than resuming a
 * chat about a page that is no longer open.
 */
export function isWriteSessionStale(
  session: WriteSession,
  currentTabUrl: string
): boolean {
  try {
    return (
      comparablePageUrl(session.pageUrl) !== comparablePageUrl(currentTabUrl)
    );
  } catch {
    return true;
  }
}
