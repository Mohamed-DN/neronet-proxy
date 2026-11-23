import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Download, ExternalLink, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { QrCode } from '../devices/QrCode';
import {
  amneziaConfigFileName,
  configFileName,
  strictConfigFileName,
  type AccessMethod,
  type StrictNetwork
} from '../devices/wgConfig';
import { useNodes } from '../services/queries/nodes';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { Logo } from '../ui/Logo';
import { StationStatus } from '../ui/StationSymbol';
import { useToast } from '../ui/Toast';
import { deviceStatus } from './deviceStatus';
import { fetchPublishedApps } from './downloads';
import {
  AMNEZIAWG_INSTALL,
  isMobilePlatform,
  LINUX_INTERFACE,
  saveTextFile,
  VLESS_APP,
  VLESS_INSTALL,
  WIREGUARD_INSTALL,
  type Platform
} from './platform';
import { StrictNetworkNotes, StrictNetworkSection, StrictNetworkSteps } from './StrictNetworkSection';

/** How often the page asks whether the new device has been heard from, and when it stops saying "waiting" and offers help. */
export const POLL_MS = 4_000;
export const SLOW_AFTER_MS = 180_000;

export interface AddResultData {
  /** The id the server gave the new device; the same id names it in the device list. */
  deviceId: string;
  name: string;
  platform: Platform;
  /** The access was made on the device it is for, so the file goes straight in and no second screen is needed. */
  sameDevice: boolean;
  /** Set when all of the device's traffic goes through one exit. */
  exitName?: string;
  /** How the device connects (ADR 0036). Absent: plain WireGuard. */
  method?: AccessMethod;
  /** The profile text. It holds the device's secret and lives in memory only. */
  config: string;
  /** The profile for networks that block VPNs, when the installation offers it. Memory only. */
  strict: { info: StrictNetwork; config: string } | null;
}

const SECONDARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-control border border-border-strong bg-surface-raised px-4 text-body font-medium text-content hover:bg-surface-hover focus-visible:outline-focus';
const PRIMARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-control border border-transparent bg-accent px-4 text-body font-medium text-accent-contrast hover:bg-accent-strong focus-visible:outline-focus';
const SUMMARY =
  'flex min-h-11 cursor-pointer items-center text-body font-medium text-content focus-visible:outline-focus';
const COMMAND =
  'mt-2 whitespace-pre-wrap break-all rounded-control border border-border-subtle bg-surface-sunken p-3 font-mono text-caption text-content';

/**
 * What comes after "Crea l'accesso": the exact steps for the chosen device, and
 * then a status line that waits for the device to appear and says "connected".
 * A phone cannot scan its own screen, so the QR code is only shown when the
 * access is for another phone or tablet; everything else is a file.
 */
export function AddResult({ result }: { result: AddResultData }) {
  const { t } = useTranslation('portal');
  const { notify } = useToast();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { platform, sameDevice } = result;
  const showQr = isMobilePlatform(platform) && !sameDevice;
  const isLinux = platform === 'linux';
  const platformName = t(`add.platform.${platform}`);
  const method = result.method ?? 'wireguard';
  const isAwg = method === 'amneziawg';
  // VLESS + REALITY: the profile is a link, imported by copying it or scanning its code, not a file.
  const isVless = method === 'vless-reality';
  // The way for networks that block VPNs is a first-class choice: its steps are the main steps.
  const isWss = method === 'wireguard-wss' && result.strict !== null;
  const fileName = isWss
    ? strictConfigFileName(result.name)
    : isAwg
      ? amneziaConfigFileName(result.name)
      : configFileName(result.name);
  const installUrl = isVless
    ? VLESS_INSTALL[platform]
    : isAwg
      ? AMNEZIAWG_INSTALL[platform]
      : WIREGUARD_INSTALL[platform];
  const howKey = isVless ? 'add.vless.how' : isAwg ? 'add.awg.how' : 'add.how';
  // Linux: the commands differ for AmneziaWG (awg-quick, its own configuration folder).
  const linuxInstall = isAwg
    ? `sudo install -m 600 ~/Downloads/${fileName} /etc/amnezia/amneziawg/${LINUX_INTERFACE}.conf\nsudo awg-quick up ${LINUX_INTERFACE}`
    : `sudo install -m 600 ~/Downloads/${fileName} /etc/wireguard/${LINUX_INTERFACE}.conf\nsudo wg-quick up ${LINUX_INTERFACE}`;
  const linuxStop = `sudo ${isAwg ? 'awg-quick' : 'wg-quick'} down ${LINUX_INTERFACE}`;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  // Waiting for the device: the same device list /me reads, asked more often.
  const [connected, setConnected] = useState(false);
  const [slow, setSlow] = useState(false);
  const nodes = useNodes({ refetchIntervalMs: connected ? undefined : POLL_MS });
  const node = nodes.data?.find((candidate) => candidate.id === result.deviceId);
  const heard = node ? deviceStatus(node, Date.now()) === 'connected' : false;
  useEffect(() => {
    if (heard) setConnected(true);
  }, [heard]);
  useEffect(() => {
    if (connected) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [connected]);

  // While the secret is on screen, leaving the page would lose it: ask first.
  // Once the device is connected nothing here is needed any more.
  useEffect(() => {
    if (connected) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [connected]);

  const apps = useQuery({
    queryKey: ['portal', 'downloads'] as const,
    queryFn: () => fetchPublishedApps(),
    staleTime: 5 * 60_000,
    enabled: isLinux && !isAwg && !isWss && !isVless
  });
  const linuxApp = isLinux && !isAwg && !isWss && !isVless ? apps.data?.find((app) => app.platform === 'linux') : undefined;

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(result.config);
      notify(t('add.result.copied'), { tone: 'success' });
    } catch {
      notify(t('code.copyFailed', { ns: 'ui' }), { tone: 'danger' });
    }
  }

  const download = (
    <Button
      variant="primary"
      size="lg"
      icon={Download}
      onClick={() => saveTextFile(result.config, fileName)}
      className="w-full sm:w-auto"
    >
      {t('add.result.download')}
    </Button>
  );

  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="text-heading font-medium text-content focus-visible:outline-focus"
      >
        {t('add.result.title', { device: platformName })}
      </h2>
      <p className="mt-2 flex items-start gap-2 text-body text-muted">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>{t('add.result.warning')}</span>
      </p>

      <ol className="mt-6 list-decimal space-y-6 ps-5 text-body text-content marker:text-muted">
        <li>
          <p>
            {isVless
              ? t('add.vless.install', { device: platformName, app: VLESS_APP[platform] })
              : t(isAwg ? 'add.awg.install' : 'add.result.install', { device: platformName })}
          </p>
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-sm underline focus-visible:outline-focus"
          >
            {isVless
              ? t('add.vless.installLink', { app: VLESS_APP[platform] })
              : t(isAwg ? 'add.awg.installLink' : 'add.result.installLink')}
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="sr-only"> {t('downloads.newTab')}</span>
          </a>
        </li>

        {isVless ? (
          showQr ? (
            <>
              <li>
                <p>{t(`add.vless.how.${platform}.scan`)}</p>
                <div className="mt-3 flex justify-center rounded-card border border-border-subtle bg-surface-raised p-4 [&_img]:h-auto [&_img]:max-w-full">
                  <QrCode value={result.config} label={t('add.vless.qrAlt', { name: result.name })} size={288} />
                </div>
                <p className="mt-2 text-center text-body font-medium text-content">{t('add.vless.scan')}</p>
              </li>
              <li>{t(`add.vless.how.${platform}.activate`)}</li>
            </>
          ) : (
            <>
              <li>
                <p>{t(sameDevice ? 'add.vless.copyHere' : 'add.vless.copyMove')}</p>
                <div className="mt-3">
                  <Button
                    variant="primary"
                    size="lg"
                    icon={Copy}
                    onClick={() => void copyConfig()}
                    className="w-full sm:w-auto"
                  >
                    {t('add.vless.copyLink')}
                  </Button>
                </div>
              </li>
              <li>{t(`add.vless.how.${platform}.import`)}</li>
              <li>{t(`add.vless.how.${platform}.activate`)}</li>
            </>
          )
        ) : isWss && result.strict ? (
          <>
            <StrictNetworkSteps strict={result.strict.info} onDownload={() => saveTextFile(result.config, fileName)} />
            <li>
              {isLinux ? (
                <>
                  <p>{t('add.linux.intro')}</p>
                  <pre className={COMMAND}>
                    <code>{linuxInstall}</code>
                  </pre>
                  <p className="mt-3 text-muted">{t('add.linux.stop')}</p>
                  <pre className={COMMAND}>
                    <code>{linuxStop}</code>
                  </pre>
                </>
              ) : (
                t(`add.how.${platform}.activate`)
              )}
            </li>
          </>
        ) : showQr ? (
          <>
            <li>
              <p>{t(`${howKey}.${platform}.scan`)}</p>
              <div className="mt-3 flex justify-center rounded-card border border-border-subtle bg-surface-raised p-4 [&_img]:h-auto [&_img]:max-w-full">
                <QrCode value={result.config} label={t('add.result.qrAlt', { name: result.name })} size={288} />
              </div>
              <p className="mt-2 text-center text-body font-medium text-content">{t('add.result.scan')}</p>
            </li>
            <li>{t(`${howKey}.${platform}.activate`)}</li>
          </>
        ) : isLinux ? (
          <>
            <li>
              <p>{t('add.result.getFile')}</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                {download}
                {linuxApp && (
                  <a
                    href={`/downloads/${encodeURIComponent(linuxApp.file)}`}
                    download={linuxApp.file}
                    className={cn(SECONDARY, 'w-full sm:w-auto')}
                  >
                    {t('add.linux.app', { version: linuxApp.version })}
                  </a>
                )}
              </div>
            </li>
            <li>
              <details>
                <summary className={SUMMARY}>{t('add.linux.show')}</summary>
                <p className="mt-2 text-muted">{t('add.linux.intro')}</p>
                <pre className={COMMAND}>
                  <code>{linuxInstall}</code>
                </pre>
                <p className="mt-3 text-muted">{t('add.linux.stop')}</p>
                <pre className={COMMAND}>
                  <code>{linuxStop}</code>
                </pre>
              </details>
            </li>
          </>
        ) : (
          <>
            <li>
              <p>{t(sameDevice ? 'add.result.getFileHere' : 'add.result.getFileMove')}</p>
              <div className="mt-3">{download}</div>
            </li>
            <li>{t(`${howKey}.${platform}.import`)}</li>
            <li>{t(`${howKey}.${platform}.activate`)}</li>
          </>
        )}
      </ol>
      {isWss && result.strict && <StrictNetworkNotes />}
      {isVless ? (
        <p className="mt-4 text-caption text-muted">{t('add.vless.note')}</p>
      ) : (
        !isLinux &&
        !isWss && <p className="mt-4 text-caption text-muted">{t(isAwg ? 'add.awg.note' : 'add.how.note')}</p>
      )}

      {result.exitName && (
        <div className="mt-6 rounded-card border border-border-subtle bg-surface-raised p-3 text-body text-content">
          <p className="flex items-start gap-2">
            <Globe aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <span>{t('add.exit.resultNote', { name: result.name, place: result.exitName })}</span>
          </p>
          <p className="mt-2 text-muted">{t('add.exit.lanNote')}</p>
        </div>
      )}

      <div
        role="status"
        data-state={connected ? 'connected' : slow ? 'slow' : 'waiting'}
        className="mt-8 rounded-card border border-border-subtle bg-surface-raised p-4"
      >
        {connected ? (
          <>
            <div className="flex items-center gap-4">
              <Logo size={64} ground="plate" decorative animate="allaccio" />
              <div>
                <p className="flex items-center gap-2 text-heading font-medium text-content">
                  <Check aria-hidden="true" className="h-5 w-5 text-success" />
                  {t('add.wait.connected', { name: result.name })}
                </p>
                <p className="mt-1 text-body text-muted">{t('add.wait.connectedBody', { name: result.name })}</p>
              </div>
            </div>
            <Link to="/me" className={cn(PRIMARY, 'mt-4 w-full sm:w-auto')}>
              {t('add.result.back')}
            </Link>
          </>
        ) : (
          <>
            <StationStatus kind="unmeasured" className="text-heading font-medium">
              {t('add.wait.title')}
            </StationStatus>
            <p className="mt-1 text-body text-muted">{t(slow ? 'add.wait.slow' : 'add.wait.body')}</p>
            <Link to="/me" className={cn(SECONDARY, 'mt-4 w-full sm:w-auto')}>
              {t('add.result.later')}
            </Link>
          </>
        )}
      </div>

      <details className="mt-8 border-t border-border-subtle pt-2" data-trouble="">
        <summary className={SUMMARY}>{t('add.trouble.title')}</summary>
        <div className="mt-2 space-y-4">
          <p className="max-w-prose text-body text-muted">{t('add.trouble.body')}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            {showQr && !isVless && (
              <Button
                variant="secondary"
                size="lg"
                icon={Download}
                onClick={() => saveTextFile(result.config, fileName)}
                className="w-full sm:w-auto"
              >
                {t('add.trouble.file')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="lg"
              icon={Copy}
              onClick={() => void copyConfig()}
              className="w-full sm:w-auto"
            >
              {t('add.result.copy')}
            </Button>
          </div>
          {method === 'wireguard' && result.strict && (
            <StrictNetworkSection
              strict={result.strict.info}
              onDownload={() => result.strict && saveTextFile(result.strict.config, strictConfigFileName(result.name))}
            />
          )}
        </div>
      </details>
    </section>
  );
}
