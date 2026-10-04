import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Link2, Plus, Search, Trash2, Unlink, UserPlus, X } from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { PageHeader } from '../../ui/PageHeader';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Checkbox } from '../../ui/Checkbox';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Dialog } from '../../ui/Dialog';
import { FormField } from '../../ui/FormField';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { EmptyState } from '../../ui/States';
import { Stat } from '../../ui/Stat';
import { useToast } from '../../ui/Toast';

import {
  useCompartmentPeerings,
  useCompartments,
  useConnectCompartments,
  useCreateCompartment,
  useDeleteCompartment,
  useDisconnectCompartments,
  useMoveToCompartment,
  useTopology
} from '../../services/queries';
import type { Compartment, CompartmentPeering, TopologyNode } from '../../services/types';

const EMPTY_NODES: TopologyNode[] = [];
const EMPTY_COMPARTMENTS: Compartment[] = [];
const EMPTY_PEERINGS: CompartmentPeering[] = [];
// Device chips shown on a card before the rest collapse into "+N more".
const CHIP_LIMIT = 8;

interface Connection {
  peeringId: string;
  other: Compartment;
}

function isDefault(c: Compartment): boolean {
  return c.slug === 'default';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Checklist of devices with a search box. Used to fill a new sub-network and to add to one. */
function DevicePicker({
  nodes,
  selected,
  onChange,
  compartmentName
}: {
  nodes: TopologyNode[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  compartmentName: (id: string | null) => string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) =>
      [n.name, n.country, n.overlay_ipv4 ?? ''].some((field) => (field ?? '').toLowerCase().includes(q))
    );
  }, [nodes, query]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('subnets.picker.search')}
          aria-label={t('subnets.picker.search')}
          className="pl-9"
        />
      </div>
      <div className="max-h-64 overflow-y-auto rounded-card border border-border">
        <ul className="divide-y divide-border">
          {visible.map((node) => (
            <li key={node.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <Checkbox
                id={`pick-${node.id}`}
                label={`${node.name || node.id}${node.country ? ` · ${node.country}` : ''}`}
                checked={selected.has(node.id)}
                onChange={() => toggle(node.id)}
              />
              <span className="shrink-0 text-caption text-muted">
                {t('subnets.picker.currentlyIn', { name: compartmentName(node.compartment_id) })}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <span className="text-caption text-muted">{t('subnets.picker.selected', { count: selected.size })}</span>
    </div>
  );
}

export function SubnetsRoute() {
  const { t } = useTranslation();
  const { notify } = useToast();

  const compartmentsQuery = useCompartments();
  const topologyQuery = useTopology();
  const peeringsQuery = useCompartmentPeerings();

  const createCompartment = useCreateCompartment();
  const deleteCompartment = useDeleteCompartment();
  const moveDevices = useMoveToCompartment();
  const connect = useConnectCompartments();
  const disconnect = useDisconnectCompartments();

  const compartments = compartmentsQuery.data ?? EMPTY_COMPARTMENTS;
  const nodes = topologyQuery.data?.nodes ?? EMPTY_NODES;
  const peerings = peeringsQuery.data ?? EMPTY_PEERINGS;

  // Dialog state: which one is open, and for which sub-network.
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addTarget, setAddTarget] = useState<Compartment | null>(null);
  const [connectFrom, setConnectFrom] = useState<Compartment | null>(null);
  const [connectTo, setConnectTo] = useState<string>('');
  const [deleteTarget, setDeleteTarget] = useState<Compartment | null>(null);

  const ordered = useMemo(
    () =>
      [...compartments].sort((a, b) =>
        isDefault(a) === isDefault(b) ? a.name.localeCompare(b.name) : isDefault(a) ? -1 : 1
      ),
    [compartments]
  );
  const defaultCompartment = ordered.find(isDefault) ?? null;
  const byId = useMemo(() => new Map(compartments.map((c) => [c.id, c])), [compartments]);

  // A node's compartment as the topology reports it: the one the policy compiler uses.
  const devicesOf = useMemo(() => {
    const map = new Map<string, TopologyNode[]>();
    for (const node of nodes) {
      const key = node.compartment_id && byId.has(node.compartment_id) ? node.compartment_id : defaultCompartment?.id;
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(node);
      map.set(key, list);
    }
    return map;
  }, [nodes, byId, defaultCompartment]);

  const connectionsOf = useMemo(() => {
    const map = new Map<string, Connection[]>();
    for (const p of peerings) {
      if (p.policy !== 'allow') continue;
      const src = byId.get(p.src_compartment_id);
      const dst = byId.get(p.dst_compartment_id);
      if (!src || !dst) continue;
      map.set(src.id, [...(map.get(src.id) ?? []), { peeringId: p.id, other: dst }]);
      map.set(dst.id, [...(map.get(dst.id) ?? []), { peeringId: p.id, other: src }]);
    }
    return map;
  }, [peerings, byId]);

  const compartmentName = (id: string | null) =>
    (id && byId.get(id)?.name) || defaultCompartment?.name || t('topology.canvas.clusterOther');

  const connectionCount = peerings.filter((p) => p.policy === 'allow').length;
  const outsideDefault = nodes.filter(
    (n) => n.compartment_id && defaultCompartment && n.compartment_id !== defaultCompartment.id
  ).length;

  const fail = (err: unknown) => notify(t('subnets.failed', { message: errorMessage(err) }), { tone: 'danger' });

  const openCreate = () => {
    setNewName('');
    setNameError(null);
    setSelected(new Set());
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setNameError(t('subnets.createDialog.nameRequired'));
      return;
    }
    try {
      const created = await createCompartment.mutateAsync(name);
      if (selected.size > 0) {
        await moveDevices.mutateAsync({ compartmentId: created.id, nodeIds: [...selected] });
      }
      setCreateOpen(false);
      notify(t('subnets.done.created', { name }), { tone: 'success' });
    } catch (err) {
      fail(err);
    }
  };

  const openAdd = (c: Compartment) => {
    setSelected(new Set());
    setAddTarget(c);
  };

  const submitAdd = async () => {
    if (!addTarget || selected.size === 0) return;
    try {
      const moved = await moveDevices.mutateAsync({ compartmentId: addTarget.id, nodeIds: [...selected] });
      setAddTarget(null);
      notify(t('subnets.done.moved', { count: moved.length }), { tone: 'success' });
    } catch (err) {
      fail(err);
    }
  };

  const moveOut = async (node: TopologyNode) => {
    if (!defaultCompartment) return;
    try {
      const moved = await moveDevices.mutateAsync({ compartmentId: defaultCompartment.id, nodeIds: [node.id] });
      notify(t('subnets.done.moved', { count: moved.length }), { tone: 'success' });
    } catch (err) {
      fail(err);
    }
  };

  const connectOptionsFor = (c: Compartment) => {
    const already = new Set((connectionsOf.get(c.id) ?? []).map((conn) => conn.other.id));
    return ordered.filter((o) => o.id !== c.id && !already.has(o.id)).map((o) => ({ value: o.id, label: o.name }));
  };

  const openConnect = (c: Compartment) => {
    setConnectTo(connectOptionsFor(c)[0]?.value ?? '');
    setConnectFrom(c);
  };

  const submitConnect = async () => {
    if (!connectFrom || !connectTo) return;
    try {
      await connect.mutateAsync({ a: connectFrom.id, b: connectTo });
      setConnectFrom(null);
      notify(t('subnets.done.connected'), { tone: 'success' });
    } catch (err) {
      fail(err);
    }
  };

  const removeConnection = async (peeringId: string) => {
    try {
      await disconnect.mutateAsync(peeringId);
      notify(t('subnets.done.disconnected'), { tone: 'success' });
    } catch (err) {
      fail(err);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteCompartment.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      notify(t('subnets.done.deleted'), { tone: 'success' });
    } catch (err) {
      fail(err);
    }
  };

  const addCandidates = addTarget
    ? nodes.filter((n) => (devicesOf.get(addTarget.id) ?? []).every((d) => d.id !== n.id))
    : [];
  const connectOptions = connectFrom ? connectOptionsFor(connectFrom) : [];

  return (
    <PageFrame>
      <PageHeader
        title={t('subnets.title')}
        description={t('subnets.description')}
        actions={
          <Button variant="primary" size="sm" icon={Plus} onClick={openCreate} disabled={nodes.length === 0}>
            {t('subnets.create')}
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label={t('subnets.stats.subnets')} value={compartments.length} />
        <Stat label={t('subnets.stats.connections')} value={connectionCount} />
        <Stat label={t('subnets.stats.outsideDefault')} value={outsideDefault} />
      </div>

      {nodes.length === 0 && compartments.length <= 1 ? (
        <Card>
          <EmptyState title={t('subnets.title')} body={t('subnets.empty')} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {ordered.map((c) => {
            const devices = devicesOf.get(c.id) ?? [];
            const connections = connectionsOf.get(c.id) ?? [];
            const canConnect = connectOptionsFor(c).length > 0;
            return (
              <Card key={c.id}>
                <section aria-labelledby={`subnet-${c.id}`} className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Boxes aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
                      <h2 id={`subnet-${c.id}`} className="truncate text-body font-semibold text-content">
                        {c.name}
                      </h2>
                      {isDefault(c) && <Badge tone="neutral">{t('subnets.defaultBadge')}</Badge>}
                      {c.is_hidden && <Badge tone="warning">{t('subnets.hiddenBadge')}</Badge>}
                    </div>
                    <span className="shrink-0 text-caption text-muted">
                      {t('subnets.devices', { count: devices.length })}
                    </span>
                  </div>

                  {devices.length === 0 ? (
                    <p className="text-caption text-muted">{t('subnets.noDevices')}</p>
                  ) : (
                    <ul className="flex flex-wrap gap-1.5">
                      {devices.slice(0, CHIP_LIMIT).map((node) => (
                        <li
                          key={node.id}
                          className="flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-caption"
                        >
                          <span className="font-mono text-content">{node.name || node.id}</span>
                          {node.country && <span className="text-muted">{node.country}</span>}
                          {!isDefault(c) && defaultCompartment && (
                            <button
                              type="button"
                              className="ml-0.5 rounded-full text-muted hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                              aria-label={t('subnets.moveOut', { name: node.name || node.id })}
                              title={t('subnets.moveOut', { name: node.name || node.id })}
                              onClick={() => moveOut(node)}
                            >
                              <X aria-hidden="true" className="h-3 w-3" />
                            </button>
                          )}
                        </li>
                      ))}
                      {devices.length > CHIP_LIMIT && (
                        <li className="px-1 text-caption text-muted">
                          {t('subnets.moreDevices', { count: devices.length - CHIP_LIMIT })}
                        </li>
                      )}
                    </ul>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 text-caption">
                    {connections.length === 0 ? (
                      <span className="text-muted">{t('subnets.isolated')}</span>
                    ) : (
                      <>
                        <span className="text-muted">{t('subnets.connectedTo')}:</span>
                        {connections.map((conn) => (
                          <span
                            key={conn.peeringId}
                            className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent-subtle px-2 py-0.5"
                          >
                            <Link2 aria-hidden="true" className="h-3 w-3 text-accent" />
                            <span className="text-content">{conn.other.name}</span>
                            <button
                              type="button"
                              className="ml-0.5 rounded-full text-muted hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                              aria-label={t('subnets.disconnect', { name: conn.other.name })}
                              title={t('subnets.disconnect', { name: conn.other.name })}
                              onClick={() => removeConnection(conn.peeringId)}
                            >
                              <Unlink aria-hidden="true" className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                    <Button variant="secondary" size="sm" icon={UserPlus} onClick={() => openAdd(c)}>
                      {t('subnets.addDevices')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={Link2}
                      onClick={() => openConnect(c)}
                      disabled={!canConnect}
                    >
                      {t('subnets.connectTo')}
                    </Button>
                    {!isDefault(c) && (
                      <Button variant="danger" size="sm" icon={Trash2} onClick={() => setDeleteTarget(c)}>
                        {t('subnets.remove')}
                      </Button>
                    )}
                  </div>
                </section>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t('subnets.createDialog.title')}
        description={t('subnets.createDialog.description')}
        size="lg"
        footer={
          <Button
            variant="primary"
            onClick={submitCreate}
            loading={createCompartment.isPending || moveDevices.isPending}
          >
            {t('subnets.createDialog.submit')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label={t('subnets.createDialog.nameLabel')} error={nameError}>
            <Input
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setNameError(null);
              }}
              placeholder={t('subnets.createDialog.namePlaceholder')}
            />
          </FormField>
          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-content">{t('subnets.createDialog.devicesLabel')}</span>
            <DevicePicker nodes={nodes} selected={selected} onChange={setSelected} compartmentName={compartmentName} />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={addTarget !== null}
        onOpenChange={(open) => !open && setAddTarget(null)}
        title={t('subnets.addDialog.title', { name: addTarget?.name ?? '' })}
        description={t('subnets.addDialog.description')}
        size="lg"
        footer={
          <Button variant="primary" onClick={submitAdd} loading={moveDevices.isPending} disabled={selected.size === 0}>
            {t('subnets.addDialog.submit')}
          </Button>
        }
      >
        {addCandidates.length === 0 ? (
          <p className="text-caption text-muted">{t('subnets.addDialog.none')}</p>
        ) : (
          <DevicePicker
            nodes={addCandidates}
            selected={selected}
            onChange={setSelected}
            compartmentName={compartmentName}
          />
        )}
      </Dialog>

      <Dialog
        open={connectFrom !== null}
        onOpenChange={(open) => !open && setConnectFrom(null)}
        title={t('subnets.connectDialog.title', { name: connectFrom?.name ?? '' })}
        description={t('subnets.connectDialog.description')}
        footer={
          <Button variant="primary" onClick={submitConnect} loading={connect.isPending} disabled={!connectTo}>
            {t('subnets.connectDialog.submit')}
          </Button>
        }
      >
        {connectOptions.length === 0 ? (
          <p className="text-caption text-muted">{t('subnets.connectDialog.none')}</p>
        ) : (
          <FormField label={t('subnets.connectDialog.targetLabel')}>
            <Select value={connectTo} onValueChange={setConnectTo} options={connectOptions} />
          </FormField>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('subnets.deleteDialog.title', { name: deleteTarget?.name ?? '' })}
        description={t('subnets.deleteDialog.description')}
        confirmLabel={t('subnets.deleteDialog.confirm')}
        tone="danger"
        onConfirm={submitDelete}
        busy={deleteCompartment.isPending}
      />
    </PageFrame>
  );
}

export default SubnetsRoute;
