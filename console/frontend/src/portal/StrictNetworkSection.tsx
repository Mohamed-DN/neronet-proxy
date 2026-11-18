import { useId } from 'react';
import { Copy, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  WSTUNNEL_RELEASE_URL,
  WSTUNNEL_VERSION,
  wstunnelCommand,
  type DesktopShell,
  type StrictNetwork
} from '../devices/wgConfig';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';

const SHELLS: DesktopShell[] = ['unix', 'windows'];

export interface StrictNetworkSectionProps {
  strict: StrictNetwork;
  /** Called to save the alternative profile; the page owns the text, which holds the private key. */
  onDownload: () => void;
}

/**
 * The steps of the way through a network that drops every UDP packet, as list items for
 * the caller's ordered list: the wstunnel client carries the device's WireGuard packets
 * over port 443, and a second profile points WireGuard at it.
 */
export function StrictNetworkSteps({ strict, onDownload }: StrictNetworkSectionProps) {
  const { t } = useTranslation('portal');
  const { notify } = useToast();

  async function copyCommand(shell: DesktopShell) {
    try {
      await navigator.clipboard.writeText(wstunnelCommand(strict, shell));
      notify(t('add.strict.copied'), { tone: 'success' });
    } catch {
      notify(t('code.copyFailed', { ns: 'ui' }), { tone: 'danger' });
    }
  }

  return (
    <>
      <li>
        {t('add.strict.install', { version: WSTUNNEL_VERSION })}{' '}
        <a
          href={WSTUNNEL_RELEASE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-sm underline focus-visible:outline-focus"
        >
          {t('add.strict.installLink', { version: WSTUNNEL_VERSION })}
          <span className="sr-only"> {t('downloads.newTab')}</span>
        </a>
      </li>
      <li>
        <p>{t('add.strict.run')}</p>
        <div className="mt-3 space-y-4">
          {SHELLS.map((shell) => {
            const label = t(`add.strict.shell.${shell}`);
            return (
              <div key={shell}>
                <p className="text-caption font-medium text-muted">{label}</p>
                <pre className="mt-1 whitespace-pre-wrap break-all rounded-control border border-border-subtle bg-surface-sunken p-3 font-mono text-caption text-content">
                  <code>{wstunnelCommand(strict, shell)}</code>
                </pre>
                <Button
                  variant="secondary"
                  size="md"
                  icon={Copy}
                  onClick={() => void copyCommand(shell)}
                  className="mt-2"
                  aria-label={t('add.strict.copyFor', { shell: label })}
                >
                  {t('add.strict.copy')}
                </Button>
              </div>
            );
          })}
        </div>
      </li>
      <li>
        <p>{t('add.strict.import')}</p>
        <Button variant="secondary" size="lg" icon={Download} onClick={onDownload} className="mt-3 w-full sm:w-auto">
          {t('add.strict.download')}
        </Button>
      </li>
    </>
  );
}

/** The notes that close the steps: the address is a secret, and phones cannot use this way. */
export function StrictNetworkNotes() {
  const { t } = useTranslation('portal');
  return (
    <>
      <p className="mt-5 max-w-prose text-caption text-muted">{t('add.strict.secret')}</p>
      <p className="mt-1 max-w-prose text-caption text-muted">{t('add.strict.phones')}</p>
    </>
  );
}

/**
 * The same way as a section of its own, for a person whose first profile did not connect.
 * For computers only; the WireGuard apps on phones cannot run the client.
 */
export function StrictNetworkSection({ strict, onDownload }: StrictNetworkSectionProps) {
  const { t } = useTranslation('portal');
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="mt-8 border-t border-border-subtle pt-6">
      <h3 id={headingId} className="text-body font-medium text-content">
        {t('add.strict.title')}
      </h3>
      <p className="mt-1 max-w-prose text-body text-muted">{t('add.strict.intro')}</p>

      <ol className="mt-4 list-decimal space-y-5 ps-5 text-body text-content">
        <StrictNetworkSteps strict={strict} onDownload={onDownload} />
      </ol>

      <StrictNetworkNotes />
    </section>
  );
}
