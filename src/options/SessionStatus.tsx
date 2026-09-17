import type { VNode } from 'preact';
import { ForcedControl } from '../shared/ForcedControl';
import { formatTimeOfDay } from '../shared/format';
import { t } from '../shared/i18n';
import {
  SETTINGS_CLEANUP_COPY,
  SETTINGS_ERROR_COPY,
  SETTINGS_INDEFINITE_COPY,
  SETTINGS_SESSION_DISCLOSURE,
  SETTINGS_STARTING_COPY,
  settingsTimedCopy,
} from '../shared/session-copy';
import type { SessionLifecycleV2, SessionSnapshotV2 } from '../shared/types';

type FixedLifecycleKind = Exclude<SessionLifecycleV2['kind'], 'active'>;

/** Every lifecycle Settings describes without reading the session. A new kind breaks this. */
const FIXED_COPY: Readonly<Record<FixedLifecycleKind, string | null>> = {
  idle: null,
  starting: SETTINGS_STARTING_COPY,
  cleanup: SETTINGS_CLEANUP_COPY,
  error: SETTINGS_ERROR_COPY,
};

/**
 * A timed session names its end wall clock. An active snapshot Settings cannot describe,
 * which boundary validation rejects upstream, reads as still starting rather than throwing.
 */
function activeCopy(snapshot: SessionSnapshotV2): string {
  const config: SessionSnapshotV2['config'] = snapshot.config;
  if (config === null) return SETTINGS_STARTING_COPY;
  if (config.duration.kind === 'until-stopped') return SETTINGS_INDEFINITE_COPY;
  if (snapshot.sessionEndsAt === null) return SETTINGS_STARTING_COPY;
  return settingsTimedCopy(formatTimeOfDay(snapshot.sessionEndsAt));
}

function statusCopy(snapshot: SessionSnapshotV2 | null): string | null {
  if (snapshot === null) return null;
  const lifecycle: SessionLifecycleV2 = snapshot.lifecycle;
  return lifecycle.kind === 'active' ? activeCopy(snapshot) : FIXED_COPY[lifecycle.kind];
}

export interface SessionStatusProps {
  snapshot: SessionSnapshotV2 | null;
}

/**
 * Settings is read-only for session control, so the status sits in the forced wrapper:
 * hover, keyboard focus, click, and `aria-describedby` all say the popup owns the
 * session. Nothing renders while idle, which is the start form's business.
 */
export function SessionStatus({ snapshot }: SessionStatusProps): VNode | null {
  const copy: string | null = statusCopy(snapshot);
  if (copy === null) return null;
  return (
    <ForcedControl
      label={t('options_session_status_label')}
      explanation={SETTINGS_SESSION_DISCLOSURE}
    >
      <p class="session-status" role="status">
        {copy}
      </p>
    </ForcedControl>
  );
}
