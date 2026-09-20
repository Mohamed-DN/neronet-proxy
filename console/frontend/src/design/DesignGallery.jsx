import React, { useState } from 'react';
import { Download, Plus, RefreshCw, Trash2 } from 'lucide-react';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  CodeText,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  Input,
  LanguageSwitcher,
  NotImplementedState,
  NotMeasured,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  StatusBadge,
  Switch,
  Table,
  Tabs,
  ThemeToggle,
  Tooltip,
  sortRows,
  useToast
} from '../ui';
import { useTheme } from '../theme/ThemeProvider';

/*
 * Every primitive, in every state, on one page.
 *
 * This exists so a change to a token or a primitive can be looked at rather
 * than guessed at: open /__design, switch the theme in the header, and the
 * whole system is on screen at once. It is reachable only from the development
 * server; see the guard in main.jsx.
 */

const TOKEN_GROUPS = [
  { name: 'Surfaces', tokens: ['surface', 'surface-raised', 'surface-sunken', 'surface-hover', 'surface-inverse'] },
  { name: 'Lines', tokens: ['border-subtle', 'border', 'border-strong'] },
  { name: 'Text', tokens: ['content', 'content-muted', 'content-subtle', 'content-inverse'] },
  { name: 'Accent', tokens: ['accent-subtle', 'accent', 'accent-strong', 'accent-contrast'] },
  { name: 'Success', tokens: ['success-subtle', 'success', 'success-strong'] },
  { name: 'Warning', tokens: ['warning-subtle', 'warning', 'warning-strong'] },
  { name: 'Danger', tokens: ['danger-subtle', 'danger', 'danger-strong'] },
  { name: 'Info', tokens: ['info-subtle', 'info', 'info-strong'] },
  {
    name: 'Chart series',
    tokens: ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8']
  },
  { name: 'Sequential ramp', tokens: ['ramp-1', 'ramp-2', 'ramp-3', 'ramp-4', 'ramp-5', 'ramp-6'] }
];

// Written out rather than composed, because Tailwind scans the source for
// complete class names and would not emit a class built at run time.
const TYPE_SCALE = [
  ['text-display', 'Display 24px'],
  ['text-title', 'Title 18px'],
  ['text-heading', 'Heading 16px'],
  ['text-body', 'Body 14px'],
  ['text-label', 'Label 13px'],
  ['text-caption', 'Caption 12px'],
  ['text-micro', 'Micro 11px']
];

const NODES = [
  { id: 'relay-de', region: 'Frankfurt', risk: 12, status: 'ok' },
  { id: 'relay-fr', region: 'Paris', risk: null, status: 'not-measured' },
  { id: 'client-es', region: 'Madrid', risk: 78, status: 'critical' },
  { id: 'derp-eu', region: 'Amsterdam', risk: 41, status: 'warning' }
];

function Section({ id, title, description, children }) {
  return (
    <section id={id} className="flex flex-col gap-3 scroll-mt-20">
      <div>
        <h2 className="text-title font-semibold text-content">{title}</h2>
        {description && <p className="mt-0.5 max-w-prose text-caption text-subtle">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Swatches() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {TOKEN_GROUPS.map((group) => (
        <Card key={group.name}>
          <CardHeader title={group.name} />
          <ul className="flex flex-col gap-1">
            {group.tokens.map((token) => (
              <li key={token} className="flex items-center gap-2">
                <span
                  className="h-6 w-10 shrink-0 rounded-sm border border-border"
                  style={{ backgroundColor: `rgb(var(--color-${token}))` }}
                />
                <code className="font-mono text-caption text-muted">--color-{token}</code>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function Controls() {
  const [checked, setChecked] = useState(true);
  const [onion, setOnion] = useState(true);
  const [protocol, setProtocol] = useState('shadow-tls');
  const { notify } = useToast();

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader title="Buttons" />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={Plus}>
            Enrol device
          </Button>
          <Button variant="secondary" icon={RefreshCw}>
            Refresh
          </Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" icon={Trash2}>
            Revoke
          </Button>
          <Button variant="primary" loading loadingLabel="Saving">
            Saving
          </Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button size="sm">Small</Button>
          <IconButton icon={Download} label="Download the profile" />
          <IconButton icon={Trash2} label="Delete" variant="danger" />
        </div>
      </Card>

      <Card>
        <CardHeader title="Fields" />
        <div className="flex flex-col gap-4">
          <FormField label="Node name" hint="Shown in the fleet list" required>
            <Input placeholder="relay-de" />
          </FormField>
          <FormField label="Overlay address" error="Outside the assigned range">
            <Input mono defaultValue="10.0.0.1" />
          </FormField>
          <FormField label="Obfuscation protocol" hint="Applied at the next handshake">
            <Select
              value={protocol}
              onValueChange={setProtocol}
              options={[
                { value: 'shadow-tls', label: 'ShadowTLS v3' },
                { value: 'vless-reality', label: 'VLESS Reality' },
                { value: 'quic-masque', label: 'QUIC MASQUE' }
              ]}
            />
          </FormField>
          <Checkbox
            label="Quarantine on a failed posture check"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <Switch checked={onion} onCheckedChange={setOnion} label="Onion routing" description="Three-hop circuits" />
        </div>
      </Card>

      <Card>
        <CardHeader title="Badges and status" description="Status is colour, icon and word together." />
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status="ok" />
          <StatusBadge status="warning" />
          <StatusBadge status="critical" />
          <StatusBadge status="unknown" />
          <StatusBadge status="not-measured" />
          <StatusBadge status="ok" compact />
          <Badge>v4.0</Badge>
          <Badge tone="accent" mono>
            Ed25519
          </Badge>
          <Badge tone="info">3-hop</Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CodeText copyable>100.64.0.12</CodeText>
          <CodeText copyable truncate>
            nodekey_01H9ZXCQ4T8V2M7KPRJD3F6WYB
          </CodeText>
        </div>
      </Card>

      <Card>
        <CardHeader title="Metrics" description="A value that was never reported says so." />
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Enrolled nodes" value={124} unit="nodes" delta={{ value: 6, label: '+6 this week' }} />
          <Stat label="Reachable" value={118} unit="nodes" delta={{ value: -2, label: '-2 this week' }} />
          <Stat label="Circuits built" value={null} hint="Circuits are not counted anywhere." />
          <Stat label="Quarantined" value={0} unit="nodes" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => notify('Access rules saved', { tone: 'success' })}>Show a confirmation</Button>
          <Button onClick={() => notify('Revocation failed: 502 from the control plane', { tone: 'danger' })}>
            Show a failure
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Overlays() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tab, setTab] = useState('routes');

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader title="Overlays" />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialogOpen(true)}>Open a dialog</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Open a typed confirmation
          </Button>
          <Tooltip content="Measured over the last minute">
            <Button variant="ghost">Hover or focus me</Button>
          </Tooltip>
        </div>

        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Cryptographic profile"
          description="The enrolment token is shown once."
          footer={
            <Button variant="primary" onClick={() => setDialogOpen(false)}>
              Done
            </Button>
          }
        >
          <FormField label="Node name">
            <Input placeholder="relay-de" />
          </FormField>
        </Dialog>

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          tone="danger"
          title="Revoke relay-de"
          description="The node loses its key and has to enrol again."
          confirmPhrase="relay-de"
          onConfirm={() => setConfirmOpen(false)}
        />
      </Card>

      <Card>
        <CardHeader title="Tabs" />
        <Tabs
          label="Node detail"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'routes', label: 'Routes', content: <p className="text-body text-muted">Route table</p> },
            {
              value: 'acls',
              label: 'ACLs',
              badge: <Badge>12</Badge>,
              content: <p className="text-body text-muted">Access rules</p>
            },
            { value: 'audit', label: 'Audit', content: <p className="text-body text-muted">Audit log</p> }
          ]}
        />
      </Card>
    </div>
  );
}

function DataStates() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader title="Loading" />
        <Skeleton lines={4} />
      </Card>
      <Card>
        <CardHeader title="Empty" />
        <EmptyState />
      </Card>
      <Card>
        <CardHeader title="Error" />
        <ErrorState detail="502 from the control plane" onRetry={() => {}} />
      </Card>
      <Card>
        <CardHeader title="Not measured and not implemented" />
        <div className="flex flex-col gap-3">
          <NotMeasured inline={false} />
          <NotImplementedState flag="cloud_pc" />
        </div>
      </Card>
    </div>
  );
}

function Tables() {
  const [sort, setSort] = useState({ columnId: 'id', direction: 'asc' });
  const [selected, setSelected] = useState(['relay-de']);
  const [density, setDensity] = useState('comfortable');

  const columns = [
    { id: 'id', header: 'Node', sortable: true, cell: (row) => <CodeText>{row.id}</CodeText> },
    { id: 'region', header: 'Region', sortable: true, cell: (row) => row.region },
    { id: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
    {
      id: 'risk',
      header: 'Risk',
      numeric: true,
      sortable: true,
      cell: (row) => (row.risk === null ? <NotMeasured /> : row.risk)
    }
  ];

  const rows = sortRows(NODES, (row) => row[sort.columnId], sort.direction);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}>
          Density: {density}
        </Button>
      </div>
      <Table
        caption="Enrolled nodes"
        showCaption
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={sort}
        onSortChange={setSort}
        density={density}
        selectedKeys={selected}
        onSelectionChange={setSelected}
      />
      <Table caption="Nodes, loading" columns={columns} rows={[]} rowKey={(row) => row.id} loading />
      <Table
        caption="Nodes, failed"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        error="502 from the control plane"
        onRetry={() => {}}
      />
    </div>
  );
}

export function DesignGallery() {
  const { theme } = useTheme();

  return (
    <div className="min-h-screen bg-surface text-content">
      <header className="sticky top-0 z-sticky flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-raised px-6 py-3">
        <div>
          <h1 className="text-title font-semibold">Design system</h1>
          <p className="text-caption text-subtle">
            Development only. Current theme: <code className="font-mono">{theme}</code>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-8">
        <PageHeader
          title="Primitives"
          description="Every primitive in every state. Switch the theme and the language above; nothing on this page should change except colour and words."
          meta={<Badge tone="accent">dev</Badge>}
        />

        <Section
          id="typography"
          title="Typography"
          description="Inter for the interface, JetBrains Mono for anything a machine produced."
        >
          <Card>
            <div className="flex flex-col gap-2">
              {TYPE_SCALE.map(([className, sample]) => (
                <p key={className} className={`${className} text-content`}>
                  {sample} &mdash; 0123456789 relay-de 100.64.0.12
                </p>
              ))}
              <p className="font-mono text-body text-content">Mono 14px &mdash; 0123456789 Il1O0 100.64.0.12</p>
            </div>
          </Card>
        </Section>

        <Section
          id="colour"
          title="Colour"
          description="Roles, not hues. Contrast is gated by scripts/design/contrast.mjs."
        >
          <Swatches />
        </Section>

        <Section id="controls" title="Controls">
          <Controls />
        </Section>

        <Section id="overlays" title="Overlays">
          <Overlays />
        </Section>

        <Section id="states" title="Data states" description="Loading, empty, error, not measured, not implemented.">
          <DataStates />
        </Section>

        <Section id="table" title="Table">
          <Tables />
        </Section>
      </main>
    </div>
  );
}

export default DesignGallery;
