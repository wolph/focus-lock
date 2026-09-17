import type { VNode } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../shared/i18n';
import type { WebsiteAccessChoice } from '../shared/types';

export interface WebsiteAccessStepProps {
  choice: WebsiteAccessChoice;
  pending: boolean;
  error: string | null;
  onEnable: () => void | Promise<void>;
  onDefer: () => void | Promise<void>;
}

export function WebsiteAccessStep(props: WebsiteAccessStepProps): VNode {
  const denied: boolean = props.choice === 'denied';
  const registrationError: boolean = props.choice === 'registration-error';
  const retry: boolean = denied || registrationError;
  const enableButton: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  const restoreEnableFocus: { current: boolean } = useRef<boolean>(false);
  useLayoutEffect((): void => {
    if (props.pending || !restoreEnableFocus.current) return;
    restoreEnableFocus.current = false;
    enableButton.current?.focus();
  }, [props.pending, props.choice, props.error]);

  const enable: () => void = (): void => {
    restoreEnableFocus.current = true;
    void props.onEnable();
  };

  return (
    <section aria-labelledby="website-access-heading">
      <h1 id="website-access-heading" tabIndex={-1}>
        {t('onboarding_access_heading')}
      </h1>
      <p>{t('onboarding_access_local_matching')}</p>
      <p>{t('onboarding_access_capability_intro')}</p>
      <p class="permission-capability">
        <strong>{t('onboarding_access_capability')}</strong>
      </p>
      <p>{t('onboarding_access_scope_note')}</p>
      {denied ? <p role="status">{t('onboarding_access_denied')}</p> : null}
      {registrationError ? <p role="status">{t('onboarding_access_registration_error')}</p> : null}
      {props.error !== null ? <p role="alert">{props.error}</p> : null}
      <div class="button-row">
        <button
          ref={enableButton}
          type="button"
          class="primary-button"
          disabled={props.pending}
          onClick={enable}
        >
          {retry ? t('onboarding_retry_button') : t('onboarding_access_enable_button')}
        </button>
        <button
          type="button"
          class="secondary-button"
          disabled={props.pending}
          onClick={(): void => void props.onDefer()}
        >
          {t('onboarding_access_defer_button')}
        </button>
      </div>
    </section>
  );
}
