import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { formatBytes } from '../i18n/format';
import { RowList } from '../ui/RowList';
import { Skeleton } from '../ui/States';
import { fetchPublishedApps, PUBLISHED_PLATFORMS, type PublishedApp } from './downloads';

/** The WireGuard app is the path for iPhone and iPad, and works everywhere else too. Official stores only. */
const WIREGUARD = {
  ios: 'https://apps.apple.com/app/wireguard/id1441195209',
  android: 'https://play.google.com/store/apps/details?id=com.wireguard.android',
  desktop: 'https://www.wireguard.com/install/'
} as const;

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** The apps the operator published, one row per platform, and the WireGuard links that always work. */
export default function DownloadApps() {
  const { t, i18n } = useTranslation('portal');
  const headingId = useId();
  const apps = useQuery({
    queryKey: ['portal', 'downloads'] as const,
    queryFn: () => fetchPublishedApps(),
    staleTime: 5 * 60_000
  });

  const byPlatform = new Map<string, PublishedApp>((apps.data ?? []).map((app) => [app.platform, app]));

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="text-heading font-medium text-content">
        {t('downloads.title')}
      </h2>
      <p className="mt-1 text-body text-muted">{t('downloads.description')}</p>

      {apps.isPending ? (
        <div className="mt-4 space-y-3">
          <Skeleton lines={2} />
          <p role="status" className="sr-only">
            {t('downloads.loading')}
          </p>
        </div>
      ) : (
        <RowList label={t('downloads.title')} className="mt-4">
          {PUBLISHED_PLATFORMS.map((platform) => {
            const app = byPlatform.get(platform);
            const platformName = t(`downloads.platform.${platform}`);
            return (
              <li key={platform} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-1 py-3">
                <div className="min-w-0">
                  <p className="text-body font-medium text-content">{platformName}</p>
                  {app ? (
                    <>
                      <p className="text-caption text-muted">
                        {t('downloads.ourApp', {
                          platform: platformName,
                          version: app.version,
                          size: formatBytes(i18n.language, app.size_bytes) ?? ''
                        })}
                      </p>
                      <p className="text-caption text-subtle">{t('downloads.checksum', { sha: app.sha256 })}</p>
                    </>
                  ) : (
                    <p className="text-caption text-muted">{t('downloads.notPublished', { platform: platformName })}</p>
                  )}
                </div>
                {app && (
                  <a
                    href={`/downloads/${encodeURIComponent(app.file)}`}
                    download={app.file}
                    className="inline-flex h-11 items-center justify-center rounded-control border border-border-strong bg-surface-raised px-4 text-body font-medium text-content hover:bg-surface-hover focus-visible:outline-focus"
                  >
                    {t('downloads.download', { platform: platformName })}
                  </a>
                )}
              </li>
            );
          })}
        </RowList>
      )}

      <div className="mt-6 space-y-3 text-body text-content">
        <p>{t('downloads.ios')}</p>
        <p>{t('downloads.wireguard')}</p>
        <ul className="flex flex-col gap-2">
          <li>
            <a
              href={WIREGUARD.ios}
              {...EXTERNAL}
              className="inline-flex min-h-11 items-center rounded-sm underline focus-visible:outline-focus"
            >
              {t('downloads.link.ios')}
              <span className="sr-only"> {t('downloads.newTab')}</span>
            </a>
          </li>
          <li>
            <a
              href={WIREGUARD.android}
              {...EXTERNAL}
              className="inline-flex min-h-11 items-center rounded-sm underline focus-visible:outline-focus"
            >
              {t('downloads.link.android')}
              <span className="sr-only"> {t('downloads.newTab')}</span>
            </a>
          </li>
          <li>
            <a
              href={WIREGUARD.desktop}
              {...EXTERNAL}
              className="inline-flex min-h-11 items-center rounded-sm underline focus-visible:outline-focus"
            >
              {t('downloads.link.desktop')}
              <span className="sr-only"> {t('downloads.newTab')}</span>
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}
