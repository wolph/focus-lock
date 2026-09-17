import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { t } from './i18n';
import { nextTheme } from './theme';
import type { ThemeMode } from './types';

interface ThemeControlProps {
  mode: ThemeMode | null;
  onChange: (next: ThemeMode) => Promise<string | null>;
  className?: string;
}

const MODE_LABELS: Readonly<Record<ThemeMode, string>> = {
  auto: t('shared_theme_auto'),
  light: t('shared_theme_light'),
  dark: t('shared_theme_dark'),
};

function ThemeIcon({ mode }: { mode: ThemeMode }): VNode {
  if (mode === 'auto') {
    return (
      <svg data-icon="theme-auto" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M12 4a8 8 0 0 0 0 16Z" fill="currentColor" />
      </svg>
    );
  }
  if (mode === 'light') {
    return (
      <svg data-icon="theme-light" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2" />
        <path
          d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    );
  }
  return (
    <svg data-icon="theme-dark" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 3.5l1.2 4.1 4.1 1.2-4.1 1.2-1.2 4.1-1.2-4.1-4.1-1.2 4.1-1.2L12 3.5Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      />
      <path
        d="M18.5 14.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ThemeControl(props: ThemeControlProps): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const current: ThemeMode = props.mode ?? 'auto';
  const next: ThemeMode = nextTheme(current);

  const changeTheme: () => Promise<void> = async (): Promise<void> => {
    if (props.mode === null || pending) return;
    setPending(true);
    setError(null);
    try {
      setError(await props.onChange(next));
    } catch {
      setError(t('shared_theme_error'));
    } finally {
      setPending(false);
    }
  };

  return (
    <span class={`theme-control${props.className === undefined ? '' : ` ${props.className}`}`}>
      <button
        type="button"
        class="theme-button"
        aria-label={t('shared_theme_button', {
          CURRENT: MODE_LABELS[current],
          NEXT: MODE_LABELS[next],
        })}
        disabled={props.mode === null || pending}
        onClick={(): void => {
          void changeTheme();
        }}
      >
        <ThemeIcon mode={current} />
      </button>
      {error === null ? null : (
        <span class="theme-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
