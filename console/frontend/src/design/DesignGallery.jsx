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
  Logo,
  NotImplementedState,
  NotMeasured,
  PageHeader,
  Select,
  STATION_KINDS,
  STATION_TONE,
  Segmented,
  Skeleton,
  StationStatus,
  StationSymbol,
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
import { TransitMap } from '../charts/TransitMap';

/*
 * Every primitive, in every state, on one page.
 *
 * This exists so a change to a token or a primitive can be looked at rather
 * than guessed at: open /__design, switch the theme in the header, and the
 * whole system is on screen at once. It is reachable only from the development
 * server; see the guard in main.jsx.
 */

const TOKEN_GROUPS = [
  { name: 'Sheet, plate and ink', tokens: ['sheet', 'plate', 'ink', 'ink-muted', 'rule'] },
  { name: 'Signal (the one accent)', tokens: ['signal', 'on-signal'] },
  {
    name: 'Lines (sub-networks, never status)',
    tokens: ['line-red', 'line-green', 'line-blue', 'line-orange', 'line-violet', 'line-sky']
  },
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
  ['text-figure', 'Figure 40px, the single overview figure'],
  ['text-page', 'Page title 28px'],
  ['text-title', 'Title 20px'],
  ['text-lead', 'Lead 16px'],
  ['text-body', 'Body 14px'],
  ['text-caption', 'Caption 12px']
];

const STATION_WORDS = {
  service: 'In service',
  unmeasured: 'Not measured',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
  interchange: 'Gateway (interchange)',
  terminus: 'Exit (terminus)'
};

const NODES = [
  { id: 'laptop-anna', region: 'Milano', risk: 12, status: 'service' },
  { id: 'phone-luca', region: 'Roma', risk: null, status: 'unmeasured' },
  { id: 'tablet-sala', region: 'Torino', risk: 78, status: 'blocked' },
  { id: 'gateway-nord', region: 'Bologna', risk: 41, status: 'interrupted' }
];

const MAP_LINES = [
  {
    key: 'main',
    heading: 'Main sub-network',
    detail: '4 devices',
    colour: 'blue',
    stations: [
      { id: 'a', label: 'laptop-anna', symbol: 'service', description: 'laptop-anna, in service' },
      {
        id: 'c',
        label: 'phone-luca',
        symbol: 'unmeasured',
        tone: STATION_TONE.unmeasured,
        description: 'phone-luca, not measured'
      }
    ]
  },
  {
    key: 'office',
    heading: 'Office',
    detail: '3 devices',
    colour: 'green',
    stations: [
      {
        id: 'e',
        label: 'tablet-sala',
        symbol: 'blocked',
        tone: STATION_TONE.blocked,
        description: 'tablet-sala, blocked'
      },
      {
        id: 'f',
        label: 'printer-hub',
        symbol: 'interrupted',
        tone: STATION_TONE.interrupted,
        description: 'printer-hub, interrupted'
      },
      { id: 'g', label: 'laptop-marta', symbol: 'service', description: 'laptop-marta, in service' }
    ]
  },
  {
    // A long line wraps at the right edge with two 45-degree chamfers and runs back.
    key: 'branch',
    heading: 'Branch offices',
    detail: '16 devices',
    colour: 'orange',
    stations: Array.from({ length: 16 }, (_, k) => ({
      id: `b${k}`,
      label: `desk-${String(k + 1).padStart(2, '0')}`,
      symbol: k === 6 ? 'interrupted' : 'service',
      tone: k === 6 ? STATION_TONE.interrupted : undefined,
      description: `desk-${k + 1}, ${k === 6 ? 'interrupted' : 'in service'}`
    }))
  }
];

// A gateway that serves two lines is one interchange they both pass through; an exit that serves
// them is the terminus they both end on.
const MAP_HUBS = [
  {
    id: 'b',
    label: 'gateway-nord',
    symbol: 'interchange',
    kind: 'interchange',
    lineKeys: ['main', 'office'],
    description: 'gateway-nord, gateway, in service'
  },
  {
    id: 'd',
    label: 'exit-milano',
    symbol: 'terminus',
    kind: 'terminus',
    lineKeys: ['main', 'office'],
    description: 'exit-milano, exit to the internet, in service'
  }
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
                  className="h-6 w-10 shrink-0 rounded-control border border-border"
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
            Add a device
          </Button>
          <Button variant="secondary" icon={RefreshCw}>
            Refresh
          </Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" icon={Trash2}>
            Disconnect
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
          <FormField label="Device name" hint="Shown in the devices list" required>
            <Input placeholder="laptop-anna" />
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
            label="Block a device that fails a security check"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <Switch
            checked={onion}
            onCheckedChange={setOnion}
            label="Private routing"
            description="Traffic passes through three relays"
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Badges"
          description="Badges tag a kind of thing. A status is never a badge: it is a station symbol and a word."
        />
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
          <Stat label="Registered devices" value={124} unit="devices" delta={{ value: 6, label: '+6 this week' }} />
          <Stat label="In service" value={118} unit="devices" delta={{ value: -2, label: '-2 this week' }} />
          <Stat label="Traffic now" value={null} hint="A second reading is needed to calculate speed." />
          <Stat label="Blocked" value={0} unit="devices" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => notify('Rules saved', { tone: 'success' })}>Show a confirmation</Button>
          <Button
            onClick={() => notify('The device was not disconnected: the server did not answer', { tone: 'danger' })}
          >
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
          title="Connection profile"
          description="The setup code is shown once."
          footer={
            <Button variant="primary" onClick={() => setDialogOpen(false)}>
              Done
            </Button>
          }
        >
          <FormField label="Device name">
            <Input placeholder="laptop-anna" />
          </FormField>
        </Dialog>

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          tone="danger"
          title="Disconnect laptop-anna"
          description="The device loses its access and has to be added again."
          confirmPhrase="laptop-anna"
          onConfirm={() => setConfirmOpen(false)}
        />
      </Card>

      <Card>
        <CardHeader title="Tabs" />
        <Tabs
          label="Device detail"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'routes', label: 'Routes', content: <p className="text-body text-muted">Route table</p> },
            {
              value: 'acls',
              label: 'Rules',
              badge: <Badge>12</Badge>,
              content: <p className="text-body text-muted">Access rules</p>
            },
            { value: 'audit', label: 'Log', content: <p className="text-body text-muted">Event log</p> }
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
        <ErrorState detail="The server did not answer" onRetry={() => {}} />
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
  const [selected, setSelected] = useState(['laptop-anna']);
  const [density, setDensity] = useState('signage');

  const columns = [
    { id: 'id', header: 'Device', sortable: true, cell: (row) => <CodeText>{row.id}</CodeText> },
    { id: 'region', header: 'City', sortable: true, cell: (row) => row.region },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StationStatus kind={row.status}>{STATION_WORDS[row.status]}</StationStatus>
    },
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
        <Segmented
          label="Row density"
          value={density}
          onChange={setDensity}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'signage', label: 'Signage (52px rows)' }
          ]}
        />
      </div>
      <Table
        caption="Devices"
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
      <Table caption="Devices, loading" columns={columns} rows={[]} rowKey={(row) => row.id} loading />
      <Table
        caption="Devices, failed"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        error="The server did not answer"
        onRetry={() => {}}
      />
    </div>
  );
}

function BrandDoDont() {
  const rules = [
    ['Do', "Leave half the mark's width clear on every side; keep it at 16 px or larger."],
    ['Do', 'Use ink on sheet or sheet on ink; the yellow dot stays yellow.'],
    ['Do', 'Use the small variant (no lower ring, heavier line) at 24 px and below.'],
    ["Don't", 'Recolour the line, add gradients or shadows, rotate or outline the mark.'],
    ["Don't", 'Move the yellow dot, or add a second yellow to the same screen.'],
    ["Don't", 'Split the word or change its weight or colour: NeroNet is one word.']
  ];
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {rules.map(([kind, text]) => (
        <li key={text} className="flex gap-3 text-body text-ink">
          <span className="w-12 shrink-0 font-semibold">{kind}</span>
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

function Brand() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-8">
          {[16, 20, 24, 28, 40, 72].map((px) => (
            <figure key={px} className="flex flex-col items-center gap-2">
              <Logo size={px} />
              <figcaption className="text-micro text-subtle">{px} px</figcaption>
            </figure>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex items-center justify-center rounded-plate border border-rule bg-sheet p-6">
          <Logo wordmark size={40} />
        </div>
        <div className="flex items-center justify-center rounded-plate border border-rule bg-plate p-6">
          <Logo wordmark size={40} ground="plate" />
        </div>
        <div
          data-theme="dark"
          className="flex items-center justify-center rounded-plate border border-rule bg-sheet p-6"
        >
          <Logo wordmark size={40} />
        </div>
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-6">
          <img src="/brand/app-icon.svg" alt="NeroNet app icon" width="96" height="96" className="rounded-plate" />
          <img src="/brand/favicon-32.png" alt="Favicon, 32 px" width="32" height="32" />
          <img src="/brand/apple-touch-icon.png" alt="Touch icon, 180 px" width="90" height="90" />
          <p className="max-w-prose text-caption text-subtle">
            The app icon is the mark in sheet colour on an ink square. Files are in public/brand/; the rules are in
            docs/brand/BRAND.md.
          </p>
        </div>
      </Card>
      <Card>
        <BrandDoDont />
      </Card>
    </div>
  );
}

export function DesignGallery() {
  const { theme } = useTheme();

  return (
    <div className="min-h-screen bg-sheet text-ink">
      <header className="sticky top-0 z-sticky flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-plate px-6 py-3">
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
          id="brand"
          title="Brand"
          description="The N as a transit line with a terminus at each end, the upper one signal yellow. Sizes, wordmark on each ground, app icon and the rules."
        >
          <Brand />
        </Section>

        <Section
          id="stations"
          title="Station symbols"
          description="The only way a status or a kind of place is drawn. Each differs in shape, and always sits beside a word."
        >
          <Card>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {STATION_KINDS.map((kind) => (
                <li key={kind} className="flex items-center gap-3">
                  <StationSymbol kind={kind} size={24} className={STATION_TONE[kind]} />
                  <span className="text-body text-ink">{STATION_WORDS[kind]}</span>
                </li>
              ))}
            </ul>
          </Card>
        </Section>

        <Section
          id="map"
          title="The map"
          description="Sub-networks are lines in the six line colours, devices are stations, a gateway is an interchange the lines pass through, an exit is the terminus they end on. Labels are horizontal ink; segments are 0, 45 or 90 degrees."
        >
          <div className="rounded-plate border border-rule bg-sheet px-2 py-3">
            <TransitMap lines={MAP_LINES} hubs={MAP_HUBS} onOpenStation={() => {}} label="Example network map" />
          </div>
        </Section>

        <Section
          id="typography"
          title="Typography"
          description="Overpass for the interface, Overpass Mono for keys, addresses and codes."
        >
          <Card>
            <div className="flex flex-col gap-2">
              {TYPE_SCALE.map(([className, sample]) => (
                <p key={className} className={`${className} text-content`}>
                  {sample} &mdash; 0123456789 laptop-anna 100.64.0.12
                </p>
              ))}
              <p className="font-mono text-body text-content">
                Overpass Mono 14px &mdash; 0123456789 Il1O0 100.64.0.12
              </p>
            </div>
          </Card>
        </Section>

        <Section
          id="colour"
          title="Colour"
          description="Roles, not hues: sheet, plate, ink, rule, one signal, six line colours. Contrast is gated by scripts/design/contrast.mjs."
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
