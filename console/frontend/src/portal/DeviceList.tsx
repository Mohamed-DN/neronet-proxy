import { CheckCircle2, ShieldOff, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatRelativeTime } from '../i18n/format';
import type { MeshNode } from '../services/types';
import { CodeText } from '../ui/CodeText';
import { IconButton } from '../ui/IconButton';
import { NotMeasured } from '../ui/States';
import { RowList } from '../ui/RowList';
import { useToast } from '../ui/Toast';
import { deviceStatus, type DeviceStatus } from './deviceStatus';

export interface DeviceListProps {
  /** Only the signed-in person's own devices. The caller filters; this list never looks at anyone else's. */
  devices: MeshNode[];
  /** The clock used for the status sentences, passed in so the page and its tests agree. */
  now: number;
}

/** One line of text per status, with an icon where the status needs a sign as well as a word. */
function StatusLine({ status, node, now }: { status: DeviceStatus; node: MeshNode; now: number }) {
  const { t, i18n } = useTranslation('portal');
  if (status === 'blocked') {
    return (
      <p className="flex items-center gap-1.5 text-caption text-danger">
        <ShieldOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {t('me.status.blocked')}
      </p>
    );
  }
  if (status === 'connected') {
    return (
      <p className="flex items-center gap-1.5 text-caption text-success">
        <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {t('me.status.connected')}
      </p>
    );
  }
  if (status === 'lastSeen') {
    const when = formatRelativeTime(i18n.language, node.last_heartbeat, new Date(now));
    return <p className="text-caption text-muted">{t('me.status.lastSeen', { when: when ?? '' })}</p>;
  }
  if (status === 'profile') return <p className="text-caption text-muted">{t('me.status.profile')}</p>;
  return <p className="text-caption text-muted">{t('me.status.never')}</p>;
}

/**
 * The person's devices as hairline rows: name, address (with a copy button
 * when the server sent one), and one sentence about the connection.
 */
export function DeviceList({ devices, now }: DeviceListProps) {
  const { t } = useTranslation('portal');
  const { notify } = useToast();

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      notify(t('me.row.copied'), { tone: 'success' });
    } catch {
      notify(t('code.copyFailed', { ns: 'ui' }), { tone: 'danger' });
    }
  }

  return (
    <RowList label={t('me.listLabel')}>
      {devices.map((node) => {
        const name = node.name ?? node.hostname ?? t('me.unnamed');
        const address = node.overlay_ipv4 ?? null;
        return (
          <li
            key={node.id}
            className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-1 py-3"
          >
            <div className="min-w-0">
              <p className="break-words text-body font-medium text-content">{name}</p>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                {address ? <CodeText>{address}</CodeText> : <NotMeasured />}
              </div>
              <div className="mt-1">
                <StatusLine status={deviceStatus(node, now)} node={node} now={now} />
              </div>
            </div>
            {address && (
              <IconButton
                icon={Copy}
                label={t('me.row.copyAddress', { name })}
                onClick={() => void copyAddress(address)}
                className="h-11 w-11"
              />
            )}
          </li>
        );
      })}
    </RowList>
  );
}
