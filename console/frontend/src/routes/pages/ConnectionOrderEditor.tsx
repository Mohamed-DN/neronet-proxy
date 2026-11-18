import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/apiClient';
import type {
  AccessMethodId,
  ChangePlan,
  ConnectionOrigin,
  DeviceRef,
  OrderChange
} from '../../services/queries/connectionOrder';
import { Button, ConfirmDialog, IconButton, Segmented, Switch, cn } from '../../ui';

type T = (key: string, options?: Record<string, unknown>) => string;

/** "da linea Viaggiatori": where an effective order came from. */
export function originLabel(t: T, origin: ConnectionOrigin): string {
  switch (origin.scope) {
    case 'line':
      return t('origin.line', { name: origin.name ?? origin.id ?? '' });
    case 'organization':
      return t('origin.organization');
    case 'device':
      return t('origin.device');
    case 'person':
      return t('origin.person');
    default:
      return t('origin.default');
  }
}

/** An order as one line of words: "WireGuard, then port 443". */
export function orderSentence(t: T, order: AccessMethodId[], forced: boolean): string {
  if (order.length === 0) return t('summary.none');
  const names = order.map((id) => t(`method.${id}.short`));
  return forced ? t('summary.forced', { method: names[0] ?? '' }) : names.join(t('summary.then'));
}

interface Item {
  id: AccessMethodId;
  enabled: boolean;
}

/** Enabled methods first, in the person's order; the rest follow, switched off. */
function seed(allowed: AccessMethodId[], order: AccessMethodId[]): Item[] {
  const on = order.filter((id) => allowed.includes(id));
  return [
    ...on.map((id) => ({ id, enabled: true })),
    ...allowed.filter((id) => !on.includes(id)).map((id) => ({ id, enabled: false }))
  ];
}

const enabledOrder = (items: Item[]) => items.filter((i) => i.enabled).map((i) => i.id);
const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]));

export interface ConnectionOrderEditorProps {
  /** Methods this scope may use (the bound set above it). */
  allowed: AccessMethodId[];
  own: { order: AccessMethodId[] | null; forced: boolean };
  inherited: { order: AccessMethodId[]; origin: ConnectionOrigin };
  /** What the "inherit" choice says: "Eredita da linea Viaggiatori", "Automatico". */
  inheritLabel: string;
  /** Methods the serving gateway runs; any other is marked as not running. Null/absent: unknown. */
  available?: AccessMethodId[] | null;
  mayEdit: boolean;
  /** Why it cannot be edited, shown instead of the buttons. */
  readOnlyNote?: string;
  /** Asks the server who would be affected; absent means "no preview". */
  onPreview?(next: OrderChange): Promise<ChangePlan>;
  onSave(next: OrderChange): Promise<unknown>;
  idPrefix: string;
}

function deviceNames(list: DeviceRef[]): string {
  return list.map((d) => d.name || d.id).join(', ');
}

/**
 * An ordered, toggleable list of access methods with "inherit" or "custom" (ADR 0037).
 *
 * Reordering never needs a pointer: each row has "move up" and "move down" buttons, and a move is
 * announced in a live region. Dragging a row by its grip is an extra for pointer users. Methods
 * that are switched off sink to the bottom and cannot be moved. Before saving, the server says
 * which devices would lose every way to connect (the save is then not offered) and which must
 * import a new profile (asked first).
 */
export function ConnectionOrderEditor({
  allowed,
  own,
  inherited,
  inheritLabel,
  available,
  mayEdit,
  readOnlyNote,
  onPreview,
  onSave,
  idPrefix
}: ConnectionOrderEditorProps) {
  const { t } = useTranslation('connection');
  const tt = t as unknown as T;
  const [mode, setMode] = useState<'inherit' | 'custom'>(own.order ? 'custom' : 'inherit');
  const [items, setItems] = useState<Item[]>(() => seed(allowed, own.order ?? inherited.order));
  const [forced, setForced] = useState(own.forced);
  const [dragging, setDragging] = useState<AccessMethodId | null>(null);
  const [announce, setAnnounce] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [blocked, setBlocked] = useState<{ devices: DeviceRef[]; total: number } | null>(null);
  const [asking, setAsking] = useState<{ next: OrderChange; plan: ChangePlan } | null>(null);

  // A save (or another editor) changed the stored setting: show what is stored now.
  const storedKey = `${own.order?.join(',') ?? '-'}|${own.forced}|${allowed.join(',')}|${inherited.order.join(',')}`;
  useEffect(() => {
    setMode(own.order ? 'custom' : 'inherit');
    setItems(seed(allowed, own.order ?? inherited.order));
    setForced(own.forced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const order = enabledOrder(items);
  const next: OrderChange = useMemo(
    () => (mode === 'inherit' ? { order: null, forced: false } : { order, forced: forced && order.length > 0 }),
    [mode, order, forced]
  );
  const dirty = !(sameList(next.order, own.order) && (next.order === null || next.forced === own.forced));
  const editable = mayEdit && !busy;

  function move(from: number, to: number) {
    const list = items.slice();
    const [moved] = list.splice(from, 1);
    if (!moved) return;
    list.splice(to, 0, moved);
    setItems(list);
    setAnnounce(
      t('list.moved', { method: t(`method.${moved.id}.short`), position: to + 1, count: enabledOrder(list).length })
    );
  }

  function toggle(id: AccessMethodId, on: boolean) {
    const rest = items.filter((i) => i.id !== id);
    const enabled = rest.filter((i) => i.enabled);
    const off = rest.filter((i) => !i.enabled);
    setItems(on ? [...enabled, { id, enabled: true }, ...off] : [...enabled, ...off, { id, enabled: false }]);
  }

  function dropOn(targetId: AccessMethodId) {
    if (!dragging || dragging === targetId) return;
    const from = items.findIndex((i) => i.id === dragging);
    const to = items.findIndex((i) => i.id === targetId);
    const target = items[to];
    if (from < 0 || to < 0 || !target?.enabled) return;
    move(from, to);
  }

  async function commit(change: OrderChange) {
    setBusy(true);
    setFailed(false);
    setBlocked(null);
    try {
      await onSave(change);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'would_strand_devices') {
        const body = (error.details ?? {}) as { devices?: DeviceRef[]; total?: number };
        setBlocked({ devices: body.devices ?? [], total: body.total ?? body.devices?.length ?? 0 });
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  async function save() {
    setFailed(false);
    setBlocked(null);
    if (!onPreview) return commit(next);
    setBusy(true);
    try {
      const plan = await onPreview(next);
      if (plan.strands_total > 0) {
        setBlocked({ devices: plan.strands, total: plan.strands_total });
        setBusy(false);
        return;
      }
      setBusy(false);
      if (plan.reimport_total > 0) {
        setAsking({ next, plan });
        return;
      }
    } catch {
      setBusy(false);
      setFailed(true);
      return;
    }
    return commit(next);
  }

  const labelOf = (id: AccessMethodId) => t(`method.${id}.name`);
  const firstOn = order[0];

  return (
    <div className="space-y-4">
      <Segmented<'inherit' | 'custom'>
        label={t('mode.label')}
        value={mode}
        onChange={(value) => editable && setMode(value)}
        options={[
          { value: 'inherit', label: inheritLabel },
          { value: 'custom', label: t('mode.custom') }
        ]}
      />

      {mode === 'inherit' ? (
        <p className="text-caption text-subtle">
          {t('inherit.gives', {
            order: orderSentence(tt, inherited.order, false),
            origin: originLabel(tt, inherited.origin)
          })}
        </p>
      ) : (
        <div className="space-y-3">
          <p id={`${idPrefix}-help`} className="text-caption text-subtle">
            {t('list.help')}
          </p>
          <ol aria-label={t('list.label')} aria-describedby={`${idPrefix}-help`} className="space-y-2">
            {items.map((item, index) => {
              const position = item.enabled ? index + 1 : null;
              const lastOn = enabledOrder(items).length - 1;
              const notRunning = Array.isArray(available) && !available.includes(item.id);
              return (
                // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- dragging is a pointer extra; the move buttons are the keyboard path
                <li
                  key={item.id}
                  draggable={editable && item.enabled}
                  onDragStart={() => setDragging(item.id)}
                  onDragOver={(event) => {
                    if (dragging) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropOn(item.id);
                    setDragging(null);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-plate border border-rule bg-plate px-3 py-2',
                    dragging === item.id && 'opacity-60',
                    !item.enabled && 'text-ink-muted'
                  )}
                >
                  <GripVertical
                    aria-hidden="true"
                    className={cn('h-4 w-4 shrink-0', item.enabled ? 'cursor-grab' : 'opacity-30')}
                  />
                  <span aria-hidden="true" className="w-5 shrink-0 text-center text-caption font-semibold tabular-nums">
                    {position ?? '–'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-medium">{labelOf(item.id)}</p>
                    <p className="text-caption text-subtle">
                      {t(`method.${item.id}.hint`)}
                      {notRunning && ` ${t('list.notRunning')}`}
                    </p>
                  </div>
                  <IconPair
                    disabledUp={!editable || !item.enabled || index === 0}
                    disabledDown={!editable || !item.enabled || index === lastOn}
                    upLabel={t('list.up', { method: t(`method.${item.id}.short`) })}
                    downLabel={t('list.down', { method: t(`method.${item.id}.short`) })}
                    onUp={() => move(index, index - 1)}
                    onDown={() => move(index, index + 1)}
                  />
                  <Switch
                    checked={item.enabled}
                    disabled={!editable || (item.enabled && order.length === 1)}
                    onCheckedChange={(on) => toggle(item.id, on)}
                    label={t('list.use', { method: t(`method.${item.id}.short`) })}
                  />
                </li>
              );
            })}
          </ol>
          <p role="status" className="sr-only">
            {announce}
          </p>
          <Switch
            checked={forced && order.length > 0}
            disabled={!editable || order.length === 0}
            onCheckedChange={setForced}
            label={t('forced.label')}
            description={firstOn ? t('forced.hint', { method: t(`method.${firstOn}.short`) }) : t('forced.none')}
          />
        </div>
      )}

      {blocked && (
        <div role="alert" className="space-y-1 rounded-plate border border-danger/40 bg-danger/10 p-3 text-body">
          <p className="font-medium">{t('blocked.title', { count: blocked.total })}</p>
          <p className="text-caption">{deviceNames(blocked.devices)}</p>
          <p className="text-caption text-subtle">{t('blocked.body')}</p>
        </div>
      )}
      {failed && (
        <p role="alert" className="font-medium text-danger">
          {t('failed')}
        </p>
      )}

      {mayEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!dirty || busy || (mode === 'custom' && order.length === 0)}
            loading={busy}
            onClick={() => void save()}
          >
            {t('save')}
          </Button>
          <Button
            disabled={!dirty || busy}
            onClick={() => {
              setBlocked(null);
              setFailed(false);
              setMode(own.order ? 'custom' : 'inherit');
              setItems(seed(allowed, own.order ?? inherited.order));
              setForced(own.forced);
            }}
          >
            {t('revert')}
          </Button>
        </div>
      ) : (
        readOnlyNote && <p className="text-caption text-subtle">{readOnlyNote}</p>
      )}

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={t('reimport.title', { count: asking?.plan.reimport_total ?? 0 })}
        description={t('reimport.body', { devices: asking ? deviceNames(asking.plan.reimport) : '' })}
        confirmLabel={t('reimport.confirm')}
        cancelLabel={t('reimport.cancel')}
        onConfirm={() => asking && void commit(asking.next)}
        busy={busy}
      />
    </div>
  );
}

function IconPair({
  disabledUp,
  disabledDown,
  upLabel,
  downLabel,
  onUp,
  onDown
}: {
  disabledUp: boolean;
  disabledDown: boolean;
  upLabel: string;
  downLabel: string;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <IconButton size="sm" variant="secondary" icon={ArrowUp} label={upLabel} disabled={disabledUp} onClick={onUp} />
      <IconButton
        size="sm"
        variant="secondary"
        icon={ArrowDown}
        label={downLabel}
        disabled={disabledDown}
        onClick={onDown}
      />
    </div>
  );
}
