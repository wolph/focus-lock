import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { t } from '../shared/i18n';

export interface DomainInputProps {
  onError?: (error: string | null) => void;
  onAdd: (raw: string) => string | null;
}

export function DomainInput({ onAdd, onError }: DomainInputProps): VNode {
  const [value, setValue]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);

  useEffect((): (() => void) => (): void => onError?.(null), [onError]);

  const submit: () => void = (): void => {
    const nextError: string | null = onAdd(value);
    setError(nextError);
    onError?.(nextError);
    if (nextError === null) setValue('');
  };

  return (
    <div class="domain-input-control">
      <label class="field-label" for="session-allow-domain">
        {t('popup_add_allowed_domain_label')}
      </label>
      <div class="domain-input-row">
        <input
          id="session-allow-domain"
          type="text"
          inputMode="url"
          autocomplete="url"
          placeholder={t('popup_allowed_domain_placeholder')}
          value={value}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'session-allow-domain-error'}
          onInput={(event: Event): void =>
            setValue((event.currentTarget as HTMLInputElement).value)
          }
          onKeyDown={(event: KeyboardEvent): void => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
        <button type="button" onClick={submit} aria-label={t('popup_add_allowed_domain_button')}>
          <span aria-hidden="true">+</span>
          <span>{t('popup_add_button')}</span>
        </button>
      </div>
      {onError === undefined && error !== null ? (
        <p id="session-allow-domain-error" class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
