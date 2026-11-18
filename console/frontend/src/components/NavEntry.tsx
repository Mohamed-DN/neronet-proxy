import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ROUTES, type RouteId } from '../routes/paths';
import { MENU_ITEM, cn } from '../ui';

export interface NavEntryProps {
  id: RouteId;
  current: boolean;
  count?: number;
  alert?: number;
  className?: string;
  /** Called when the entry is chosen, for a sheet that closes itself. */
  onNavigate?: () => void;
}

/** One page in a group's menu or sheet: its name, a count, and an alert in words for a reader. */
export function NavEntry({ id, current, count, alert = 0, className, onNavigate }: NavEntryProps) {
  const { t } = useTranslation('chrome');

  return (
    <Link
      to={ROUTES[id]}
      aria-current={current ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(MENU_ITEM, className)}
    >
      <span className={cn('flex-1', current && 'font-semibold')}>{t(`nav.items.${id}`)}</span>
      {count !== undefined && <span className="text-caption tabular-nums text-muted">{count}</span>}
      {alert > 0 && (
        <span className="text-caption font-semibold tabular-nums text-ink">
          {alert}
          <span className="sr-only"> {t('nav.alertCount', { count: alert })}</span>
        </span>
      )}
    </Link>
  );
}
