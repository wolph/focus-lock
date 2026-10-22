/**
 * The document-side enforcement loop. It owns one `ContentEnforcementState`, applies every parsed
 * command in order, answers the worker exactly once per parsed command, and decides whether this
 * navigation stops loading. Everything the browser supplies arrives through the host, so the loop
 * runs in a test without a chrome API.
 */
import type {
  ContentEnforcementResponse,
  ContentEnforcementState,
  DocumentContentCommand,
  DocumentOverlayView,
} from '../shared/enforcement-v2';
import { parseDocumentContentCommand } from '../shared/enforcement-v2-validation';
import { isDenseArray } from '../shared/exact-data';
import type { Verdict } from '../shared/types';
import { isRecord } from '../shared/v2-domain-intrinsics';
import type { ContentCommandResultV2 } from './enforcement-state';
import { createContentEnforcementState, handleContentCommandV2 } from './enforcement-state';
import {
  claimContentLifecycle,
  docStateFor,
  installPersistedPageShow,
  markDocumentStopped,
  recoverRestoredOverlay,
  STOPPED_DOCUMENT_TITLE,
  shouldStop,
} from './gate';
import { type MountedOverlay, mountedOverlay } from './overlay-state';
import { clearDocumentOverlay, refreshWorkTarget, renderDocumentOverlay } from './overlay-v2';

type DocState = 'fresh' | 'loaded';

export interface DocumentEnforcementHostV2 {
  scope: Record<string, unknown>;
  document: Document;
  window: Window;
  now(): number;
  requestVerdict(url: string, docState: 'fresh' | 'loaded'): Promise<unknown>;
  addMessageListener(
    listener: (
      message: unknown,
      respond: (response: ContentEnforcementResponse | undefined) => void,
    ) => void,
  ): void;
}

interface DocumentLoop {
  host: DocumentEnforcementHostV2;
  state: ContentEnforcementState;
  stopped: boolean;
}

/**
 * Claims this document once, then asks the worker for its verdict. A restored document reports
 * whether it was already stopped, so a bfcache restore never stops a second time.
 */
export function installDocumentEnforcement(host: DocumentEnforcementHostV2): void {
  if (!claimContentLifecycle(host.scope)) return;
  const loop: DocumentLoop = {
    host,
    state: createContentEnforcementState(),
    stopped: recoverRestoredOverlay(host.document, host.scope),
  };
  host.addMessageListener(
    (
      message: unknown,
      respond: (response: ContentEnforcementResponse | undefined) => void,
    ): void => {
      handleMessage(loop, message, respond);
    },
  );
  installPersistedPageShow(host.window, (): void => {
    void evaluate(loop, 'loaded');
  });
  void evaluate(loop, docStateFor(host.document.readyState));
}

/**
 * Answers every command this document parses, including a rejected one, because the listener
 * wrapper holds the channel open and an unanswered channel hangs the worker until this document
 * unloads. The two broadcasts are not commands and get no answer: one re-asks for the verdict,
 * the other re-reads the work target the blocked page offers. Anything else belongs to another
 * listener and is left alone.
 */
function handleMessage(
  loop: DocumentLoop,
  message: unknown,
  respond: (response: ContentEnforcementResponse | undefined) => void,
): void {
  if (isBroadcast(message, 'reevaluate')) {
    void evaluate(loop, 'loaded');
    return;
  }
  if (isBroadcast(message, 'workTargetChanged')) {
    refreshWorkTarget();
    return;
  }
  const command: DocumentContentCommand | null = parseDocumentContentCommand(message);
  if (command === null) return;
  respond(applyCommand(loop, command, 'loaded') ?? undefined);
}

function isBroadcast(message: unknown, type: 'reevaluate' | 'workTargetChanged'): boolean {
  return isRecord(message) && message.type === type;
}

/**
 * Asks the worker for this URL and applies the commands it answers with, in order. A worker that
 * cannot answer leaves the navigation unblocked: the documented fresh-navigation fail-open.
 */
async function evaluate(loop: DocumentLoop, docState: DocState): Promise<void> {
  try {
    const response: unknown = await loop.host.requestVerdict(observedUrl(loop), docState);
    for (const command of verdictCommands(response)) applyCommand(loop, command, docState);
  } catch {
    // The worker can disappear during shutdown. This navigation waits for the next push.
  }
}

function verdictCommands(response: unknown): DocumentContentCommand[] {
  if (!isRecord(response) || !isDenseArray(response.commands)) return [];
  const commands: DocumentContentCommand[] = [];
  for (const entry of response.commands) {
    const command: DocumentContentCommand | null = parseDocumentContentCommand(entry);
    if (command !== null) commands.push(command);
  }
  return commands;
}

function applyCommand(
  loop: DocumentLoop,
  command: DocumentContentCommand,
  docState: DocState,
): ContentEnforcementResponse | null {
  const result: ContentCommandResultV2 = handleContentCommandV2(
    loop.state,
    command,
    observedUrl(loop),
    loop.host.now(),
  );
  loop.state = result.state;
  applyRender(loop, result.render, docState);
  return result.response;
}

/** The accepted state owns the render. A blocked command always carries the view it renders. */
function applyRender(
  loop: DocumentLoop,
  render: ContentCommandResultV2['render'],
  docState: DocState,
): void {
  if (render === 'none') return;
  if (render === 'clear') {
    clearDocumentOverlay();
    return;
  }
  const view: DocumentOverlayView | null = loop.state.overlay;
  const verdict: Verdict | null = loop.state.verdict;
  if (view === null || verdict === null) return;
  if (shouldStop(verdict.blocked, docState)) stopDocument(loop);
  reattachOwnHost(loop.host.document);
  renderDocumentOverlay(view, verdict);
}

/** The page can detach the host, so a repaint puts this content script's own host back first. */
function reattachOwnHost(doc: Document): void {
  const own: MountedOverlay | null = mountedOverlay();
  if (own !== null && !own.host.isConnected) doc.documentElement.append(own.host);
}

/**
 * Stops a blocked fresh navigation before it paints. What is left is an empty document plus the
 * overlay host, and an observer removes whatever the parser appends after the stop. The head and
 * the host are kept by reference, never by tag name, because the page can create elements with
 * either name, and an XML document reports lower-case tag names. The host is never detached,
 * because detaching it would drop the focus a person may already hold inside it.
 */
function stopDocument(loop: DocumentLoop): void {
  if (loop.stopped) return;
  loop.stopped = true;
  markDocumentStopped(loop.host.scope);
  const doc: Document = loop.host.document;
  loop.host.window.stop();
  const head: Element = doc.createElement('head');
  const own: Element | null = mountedOverlay()?.host ?? null;
  for (const child of Array.from(doc.documentElement.childNodes)) {
    if (child !== own) child.remove();
  }
  doc.documentElement.prepend(head);
  const observer: MutationObserver = new MutationObserver((): void => {
    removeStoppedPageContent(doc, head);
  });
  observer.observe(doc.documentElement, { childList: true });
  doc.title = STOPPED_DOCUMENT_TITLE;
}

/** Keeps only the head the stop created and the host this content script mounted. */
function removeStoppedPageContent(doc: Document, head: Element): void {
  const own: Element | null = mountedOverlay()?.host ?? null;
  for (const child of Array.from(doc.documentElement.children)) {
    if (child !== head && child !== own) child.remove();
  }
  if (own !== null && !own.isConnected) doc.documentElement.append(own);
}

function observedUrl(loop: DocumentLoop): string {
  return loop.host.window.location.href;
}
