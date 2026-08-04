import {
  type OutboundLinkFollowStatus,
  addOutboundLinkLibraryEntry,
  getOutboundLinkLibrary,
  normalizeOutboundLinkDomain,
  normalizeOutboundLinkUrl,
  updateOutboundLinkLibraryEntry,
} from '@/storage/outbound-link-library';

/**
 * Narrow runner-facing port for the domain-level outbound-link library. The
 * batch state machine records observations without depending on storage shape.
 */
export interface TargetLibraryObservation {
  loginRequired?: boolean;
  captchaRequired?: boolean;
  followStatus?: Exclude<OutboundLinkFollowStatus, 'unknown'>;
}

export interface TargetLibraryGateState {
  loginRequired: boolean;
  captchaRequired: boolean;
}

function domainOf(value: string): string | null {
  try {
    return normalizeOutboundLinkDomain(value);
  } catch {
    return null;
  }
}

function hasOwn(value: object, key: keyof TargetLibraryObservation): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export async function getTargetLibraryGateState(
  url: string
): Promise<TargetLibraryGateState> {
  const domain = domainOf(url);
  if (!domain) return { loginRequired: false, captchaRequired: false };
  const entries = await getOutboundLinkLibrary();
  return {
    loginRequired: entries.some(
      (entry) => entry.domain === domain && entry.loginRequired === true
    ),
    captchaRequired: entries.some(
      (entry) => entry.domain === domain && entry.captchaRequired === true
    ),
  };
}

export async function observeTargetLibrary(
  url: string,
  observation: TargetLibraryObservation
): Promise<void> {
  const domain = domainOf(url);
  if (!domain) return;
  let targetUrl: string;
  try {
    targetUrl = normalizeOutboundLinkUrl(url);
  } catch {
    return;
  }
  const updates: {
    followStatus?: Exclude<OutboundLinkFollowStatus, 'unknown'>;
    loginRequired?: boolean;
    captchaRequired?: boolean;
  } = {};
  if (hasOwn(observation, 'followStatus')) {
    updates.followStatus = observation.followStatus;
  }
  if (hasOwn(observation, 'loginRequired')) {
    updates.loginRequired = observation.loginRequired;
  }
  if (hasOwn(observation, 'captchaRequired')) {
    updates.captchaRequired = observation.captchaRequired;
  }
  if (Object.keys(updates).length === 0) return;

  const entries = await getOutboundLinkLibrary();
  const existing = entries.find((entry) => entry.url === targetUrl);
  if (!existing) {
    await addOutboundLinkLibraryEntry({
      url: targetUrl,
      ...updates,
    });
    return;
  }
  await updateOutboundLinkLibraryEntry({ id: existing.id, ...updates });
}
