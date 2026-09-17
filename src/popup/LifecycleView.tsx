import type { VNode } from 'preact';
import { t } from '../shared/i18n';
import type { SessionRequestV2 } from '../shared/messages';
import {
  DATA_CLEAR_ERROR_COPY,
  DATA_CLEAR_PENDING_COPY,
  POPUP_CLOSURE_CLEANUP_COPY,
  POPUP_CLOSURE_ERROR_COPY,
  POPUP_STARTING_COPY,
  POPUP_TRANSITION_CLEANUP_COPY,
  POPUP_TRANSITION_ERROR_COPY,
  RETRY_CLEANUP_LABEL,
  RETRY_FAILED_COPY,
} from '../shared/session-copy';
import type {
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
  SetupState,
} from '../shared/types';
import { GatePanel } from './GatePanel';
import {
  endControl,
  gateConfirmLabel,
  gateIdentity,
  gateIntention,
  gatePhraseLabel,
  mapGateError,
  sendGateCommand,
  useV2Command,
  type V2Command,
} from './v2-command';

const HIDDEN_AUTHORITY: EndAuthorityV2 = { kind: 'hidden' };

/** The retries this view offers. Every other v2 command belongs to another surface. */
type RetryCommandV2 = Extract<
  SessionRequestV2,
  { type: 'retryTransitionCleanup' | 'retryClosureCleanup' | 'retryDataClear' }
>;

type CleanupJournal = Extract<SessionLifecycleV2, { kind: 'cleanup' }>['journal'];
type CleanupErrorCode = Extract<SessionLifecycleV2, { kind: 'error' }>['code'];

/** Both cleanup journals. A new journal kind breaks this record. */
const CLEANUP_COPY: Readonly<Record<CleanupJournal, string>> = {
  transition: POPUP_TRANSITION_CLEANUP_COPY,
  closure: POPUP_CLOSURE_CLEANUP_COPY,
};

/** Both exhausted cleanup errors and their retries. A new code breaks this record. */
const CLEANUP_ERROR_ROWS: Readonly<
  Record<CleanupErrorCode, { copy: string; retry: RetryCommandV2 }>
> = {
  'transition-cleanup-failed': {
    copy: POPUP_TRANSITION_ERROR_COPY,
    retry: { type: 'retryTransitionCleanup' },
  },
  'closure-cleanup-failed': {
    copy: POPUP_CLOSURE_ERROR_COPY,
    retry: { type: 'retryClosureCleanup' },
  },
};

/** One rendered lifecycle row: its exact copy, its End authority, and its retry. */
interface LifecycleBody {
  copy: string;
  authority: EndAuthorityV2;
  retry: RetryCommandV2 | null;
}

interface EndGateView {
  gate: GateState;
  title: string;
  phraseLabel: string | undefined;
  confirmLabel: string | undefined;
  intention: string;
}

export interface LifecycleViewProps {
  /** null only while an all-data journal renders before a snapshot has arrived. */
  snapshot: SessionSnapshotV2 | null;
  now: number;
  dataClear: SetupState['dataClear'];
}

/**
 * The all-data journal overrides every lifecycle, idle Setup included. A clear of one
 * other scope leaves the session surfaces alone, so it never reaches this view.
 */
function dataClearBody(dataClear: LifecycleViewProps['dataClear']): LifecycleBody | null {
  if (dataClear.status === 'idle' || dataClear.scope !== 'all') return null;
  if (dataClear.status === 'pending') {
    return { copy: DATA_CLEAR_PENDING_COPY, authority: HIDDEN_AUTHORITY, retry: null };
  }
  return {
    copy: DATA_CLEAR_ERROR_COPY,
    authority: HIDDEN_AUTHORITY,
    retry: { type: 'retryDataClear' },
  };
}

/** null while idle or active, which are owned by the start form and the active view. */
function lifecycleBody(snapshot: SessionSnapshotV2): LifecycleBody | null {
  const lifecycle: SessionLifecycleV2 = snapshot.lifecycle;
  if (lifecycle.kind === 'starting') {
    return { copy: POPUP_STARTING_COPY, authority: lifecycle.endAuthority, retry: null };
  }
  if (lifecycle.kind === 'cleanup') {
    return { copy: CLEANUP_COPY[lifecycle.journal], authority: HIDDEN_AUTHORITY, retry: null };
  }
  if (lifecycle.kind === 'error') {
    const row: { copy: string; retry: RetryCommandV2 } = CLEANUP_ERROR_ROWS[lifecycle.code];
    return { copy: row.copy, authority: HIDDEN_AUTHORITY, retry: row.retry };
  }
  return null;
}

/**
 * The authority is the only gate source here: a starting snapshot may still carry a
 * pause or unlock gate, which this view must never render.
 */
function endGateView(
  authority: EndAuthorityV2,
  config: SessionConfigV2 | null,
): EndGateView | null {
  if (authority.kind !== 'friction-gate' || authority.gate === null) return null;
  return {
    gate: authority.gate,
    title: t('shared_gate_end_title'),
    phraseLabel: gatePhraseLabel(authority, authority.gate),
    confirmLabel: gateConfirmLabel(authority, authority.gate),
    intention: gateIntention(authority, authority.gate, config),
  };
}

/**
 * Starting, cleanup, and error states. Each row shows its exact copy, the End authority
 * the worker published for it, and the retry its journal allows. Idle and active belong
 * to the start form and the active view, so this view renders nothing for them.
 */
export function LifecycleView({ snapshot, now, dataClear }: LifecycleViewProps): VNode | null {
  const command: V2Command = useV2Command();

  const body: LifecycleBody | null =
    dataClearBody(dataClear) ?? (snapshot === null ? null : lifecycleBody(snapshot));
  if (body === null) return null;

  const endGate: EndGateView | null = endGateView(body.authority, snapshot?.config ?? null);
  const endAction: VNode | null = endControl(body.authority, command);
  const retryCommand: RetryCommandV2 | null = body.retry;

  const retryControl: VNode | null =
    retryCommand === null ? null : (
      <button
        type="button"
        class="start-button"
        disabled={command.pending}
        onClick={(): void => void command.run(retryCommand, RETRY_FAILED_COPY)}
      >
        {RETRY_CLEANUP_LABEL}
      </button>
    );

  return (
    <section class="view lifecycle-view">
      <p class="lifecycle-view__copy" role="status">
        {body.copy}
      </p>
      {endGate !== null ? (
        <>
          <h2 class="lifecycle-view__title">{endGate.title}</h2>
          <GatePanel
            key={gateIdentity(endGate.gate)}
            gate={endGate.gate}
            now={now}
            intention={endGate.intention}
            phraseLabel={endGate.phraseLabel}
            confirmLabel={endGate.confirmLabel}
            sendCommand={sendGateCommand}
            commandError={mapGateError}
          />
        </>
      ) : retryControl !== null || endAction !== null ? (
        <div class="actions">
          {retryControl}
          {endAction}
        </div>
      ) : null}
      {command.error !== null ? (
        <p class="form-error" role="alert">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}
