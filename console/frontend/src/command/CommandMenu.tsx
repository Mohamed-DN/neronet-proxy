import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Search } from 'lucide-react';

import { useAuth } from '../context/AuthContext';
import { useFeatures, useNodes } from '../services/queries';
import { canSee, effectiveRole, roleTier } from '../services/roles';
import { nodePath, ROUTES, type RouteId } from '../routes/paths';
import { Dialog } from '../ui';

/** The pages in sidebar order. The menu lists only the ones this role may see. */
const PAGE_IDS: readonly RouteId[] = [
  'overview',
  'topology',
  'subnets',
  'nodes',
  'onion',
  'peering',
  'cloudpc',
  'risk',
  'acls',
  'audit',
  'users',
  'settings',
  'nuke',
  'me',
  'glossary'
];

const GROUPS = ['pages', 'devices', 'actions'] as const;
type Group = (typeof GROUPS)[number];
const MAX_DEVICES = 8;

interface Item {
  key: string;
  group: Group;
  label: string;
  run: () => void;
}

export interface CommandMenuProps {
  /** Opens the enrolment dialog. Without it the "Add device" action is not offered. */
  onAddDevice?: () => void;
}

/**
 * The Ctrl/Cmd+K menu: pages, devices and one action, in one keyboard-driven list.
 *
 * It is a combobox that owns a listbox (ARIA 1.2). The panel mounts only while
 * the menu is open, so the device list is read from the shared `useNodes` cache
 * when the person asks for it and costs nothing on every other page.
 */
export default function CommandMenu({ onAddDevice }: CommandMenuProps) {
  const { t } = useTranslation(['command', 'chrome']);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  const shortcut = isMac ? '⌘ K' : 'Ctrl K';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('open')}
        aria-haspopup="dialog"
        className="inline-flex min-h-9 items-center gap-2 rounded-control border border-border bg-surface-sunken px-3 text-caption text-muted transition-colors hover:text-content focus-visible:outline-focus"
      >
        <Search aria-hidden="true" className="h-3.5 w-3.5" />
        <span>{t('trigger')}</span>
        <kbd aria-hidden="true" className="rounded-sm border border-border px-1 text-micro text-subtle">
          {shortcut}
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen} title={t('open')} description={t('hint')} size="md">
        <CommandPanel onDone={() => setOpen(false)} onAddDevice={onAddDevice} />
      </Dialog>
    </>
  );
}

function CommandPanel({ onDone, onAddDevice }: { onDone: () => void; onAddDevice?: () => void }) {
  const { t } = useTranslation(['command', 'chrome']);
  const navigate = useNavigate();
  const { user } = useAuth();
  const role = effectiveRole(user);
  const featuresQuery = useFeatures();
  const features = useMemo(() => featuresQuery.data ?? { cloud_pc: false }, [featuresQuery.data]);
  const nodes = useNodes();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const needle = query.trim().toLowerCase();

  // Focus the input once the panel is in the dialog. The dialog would otherwise
  // focus its close button, which comes first in the markup.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    const matches = (label: string) => needle === '' || label.toLowerCase().includes(needle);

    const pages: Item[] = PAGE_IDS.filter((id) => canSee(id, role, features))
      .map((id) => ({
        key: `page-${id}`,
        group: 'pages' as const,
        label: t(`chrome:nav.items.${id}`),
        run: () => navigate(ROUTES[id])
      }))
      .filter((item) => matches(item.label));

    // Devices appear only once the person has typed something; the list is long.
    const devices: Item[] =
      needle === ''
        ? []
        : (nodes.data ?? [])
            .filter((node) =>
              [node.name, node.hostname, node.overlay_ipv4, node.overlay_ipv6].some((value) =>
                value?.toLowerCase().includes(needle)
              )
            )
            .slice(0, MAX_DEVICES)
            .map((node) => ({
              key: `device-${node.id}`,
              group: 'devices' as const,
              label: node.name || node.hostname || node.id,
              run: () => navigate(nodePath(node.id))
            }));

    // A read-only role has nothing to add, so the action is not offered to it.
    const addLabel = t('actions.addDevice');
    const actions: Item[] =
      onAddDevice && roleTier(role) !== 'read' && matches(addLabel)
        ? [{ key: 'action-add-device', group: 'actions', label: addLabel, run: () => onAddDevice() }]
        : [];

    return [...pages, ...devices, ...actions];
  }, [needle, role, features, nodes.data, onAddDevice, navigate, t]);

  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (key: string) => `${listId}-${key}`;

  const runItem = (item: Item) => {
    item.run();
    onDone();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[current];
      if (item) runItem(item);
    }
  };

  const activeItem = items[current];

  return (
    <div className="flex flex-col gap-3">
      <input
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={items.length > 0 ? listId : undefined}
        aria-activedescendant={activeItem ? optionId(activeItem.key) : undefined}
        aria-label={t('placeholder')}
        placeholder={t('placeholder')}
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="min-h-11 w-full rounded-control border border-border-strong bg-surface-sunken px-3 text-body text-content placeholder:text-subtle focus-visible:outline-focus"
      />

      {items.length > 0 ? (
        <div role="listbox" id={listId} aria-label={t('open')} className="flex max-h-80 flex-col overflow-y-auto">
          {GROUPS.map((group) => {
            const groupItems = items.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            const headingId = `${listId}-${group}`;
            return (
              <div key={group} role="group" aria-labelledby={headingId} className="py-1">
                <div id={headingId} role="presentation" className="px-3 py-1 text-caption font-semibold text-muted">
                  {t(`groups.${group}`)}
                </div>
                {groupItems.map((item) => {
                  const index = items.indexOf(item);
                  return (
                    <div
                      key={item.key}
                      id={optionId(item.key)}
                      role="option"
                      aria-selected={index === current}
                      onMouseEnter={() => setActive(index)}
                      tabIndex={-1}
                      onClick={() => runItem(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') runItem(item);
                      }}
                      className={[
                        'flex min-h-11 cursor-pointer items-center rounded-control px-3 text-body text-content',
                        index === current ? 'bg-surface-hover' : ''
                      ].join(' ')}
                    >
                      {item.label}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        needle !== '' && (
          <p role="status" className="px-3 py-4 text-caption text-muted">
            {t('noResults', { q: query.trim() })}
          </p>
        )
      )}
    </div>
  );
}
