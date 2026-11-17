import { RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatRelativeTime } from '../i18n/format';
import type { MeshNode } from '../services/types';
import { Button } from '../ui/Button';
import { CodeText } from '../ui/CodeText';
import { RowList } from '../ui/RowList';
import { StationStatus, type StationKind } from '../ui/StationSymbol';
import { deviceStatus, seenAt, type DeviceStatus } from './deviceStatus';

export interface DeviceListProps {
  /** Only the signed-in person's own devices. The caller filters; this list never looks at anyone else's. */
  devices: MeshNode[];
  /** The clock used for the status sentences, passed in so the page and its tests agree. */
  now: number;
  /** Asks to remove one device. The page owns the confirmation. */
  onRemove?: (node: MeshNode) => void;
  /** Asks to make a new access for a phone or computer that uses the WireGuard app. The page owns the confirmation. */
  onRebuild?: (node: MeshNode) => void;
}

/** The station symbol that goes with each status; the word beside it says the same thing. */
const STATION: Record<DeviceStatus, StationKind> = {
  blocked: 'blocked',
  connected: 'service',
  lastSeen: 'interrupted',
  profile: 'unmeasured',
  never: 'unmeasured'
};

/**
 * The person's devices as hairline rows: a station symbol and one word for how
 * the device is doing, its name, and the name the network gives it.
 */
export function DeviceList({ devices, now, onRemove, onRebuild }: DeviceListProps) {
  const { t, i18n } = useTranslation('portal');

  return (
    <RowList label={t('me.listLabel')}>
      {devices.map((node) => {
        const name = node.name ?? node.hostname ?? t('me.unnamed');
        const status = deviceStatus(node, now);
        const when = status === 'lastSeen' ? formatRelativeTime(i18n.language, seenAt(node), new Date(now)) : null;
        const canRebuild = onRebuild && node.device_kind === 'profile';
        return (
          <li key={node.id} className="flex flex-col gap-3 px-1 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="break-words text-body font-medium text-content">{name}</p>
              <p className="mt-1">
                <StationStatus kind={STATION[status]}>{t(`me.status.${status}`, { when: when ?? '' })}</StationStatus>
              </p>
              {node.dns_name && (
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-muted">
                  <span>{t('me.row.reachableAs')}</span>
                  <CodeText>{node.dns_name}</CodeText>
                </p>
              )}
            </div>
            {(canRebuild || onRemove) && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {canRebuild && (
                  <Button
                    variant="secondary"
                    size="lg"
                    icon={RefreshCw}
                    aria-label={t('me.row.rebuildLabel', { name })}
                    onClick={() => onRebuild(node)}
                  >
                    {t('me.row.rebuild')}
                  </Button>
                )}
                {onRemove && (
                  <Button
                    variant="ghost"
                    size="lg"
                    icon={Trash2}
                    aria-label={t('me.row.removeLabel', { name })}
                    onClick={() => onRemove(node)}
                  >
                    {t('me.row.remove')}
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </RowList>
  );
}
