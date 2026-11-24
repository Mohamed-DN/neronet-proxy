import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../../i18n';
import { renderUI } from '../../test/harness';
import { layoutMesh } from './topologyGraph';
import { LocationValue, ResponseValue, countryOptions } from './liveValues';
import type { TopologyNode } from '../../services/types';

const NOW = Date.parse('2026-11-23T10:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

afterEach(async () => {
  await setLanguage('en');
});

describe('location', () => {
  it('says Location unknown when nobody stated a country, in English and in Italian', async () => {
    const { unmount } = renderUI(<LocationValue countryCode={null} />);
    expect(screen.getByText('Location unknown')).toBeInTheDocument();
    unmount();
    await setLanguage('it');
    renderUI(<LocationValue countryCode={undefined} />);
    expect(screen.getByText('Posizione sconosciuta')).toBeInTheDocument();
  });

  it('shows a stated country with who stated it, never a default', () => {
    const { unmount } = renderUI(<LocationValue countryCode="IT" source="declared" withSource />);
    expect(screen.getByText('Italy · stated by an administrator')).toBeInTheDocument();
    unmount();
    renderUI(<LocationValue countryCode="DE" source="agent" withSource />);
    expect(screen.getByText("Germany · set by the device's operator")).toBeInTheDocument();
  });

  it('offers real countries for the select, by name', () => {
    const options = countryOptions('en');
    expect(options.length).toBeGreaterThan(200);
    expect(options.find((o) => o.value === 'IT')?.label).toBe('Italy');
    expect(options.some((o) => o.value === 'ZZ')).toBe(false);
  });
});

describe('response time', () => {
  it('shows the figure with its age, no reply with its age, or not measured', async () => {
    const { unmount } = renderUI(<ResponseValue rttMs={12.5} measuredAt={ago(20)} now={NOW} />);
    expect(screen.getByText(/12\.5 ms · 20 seconds ago/)).toBeInTheDocument();
    unmount();
    const second = renderUI(<ResponseValue rttMs={null} measuredAt={ago(45)} now={NOW} />);
    expect(screen.getByText(/No reply · 45 seconds ago/)).toBeInTheDocument();
    second.unmount();
    renderUI(<ResponseValue rttMs={null} measuredAt={null} now={NOW} />);
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByText(/ms/)).not.toBeInTheDocument();
  });

  it('is worded in Italian', async () => {
    await setLanguage('it');
    renderUI(<ResponseValue rttMs={null} measuredAt={ago(30)} now={NOW} />);
    expect(screen.getByText(/Nessuna risposta · 30 secondi fa/)).toBeInTheDocument();
  });

  it('ages as the clock moves', () => {
    const first = renderUI(<ResponseValue rttMs={3} measuredAt={ago(20)} now={NOW} />);
    expect(screen.getByText(/20 seconds ago/)).toBeInTheDocument();
    first.rerender(<ResponseValue rttMs={3} measuredAt={ago(20)} now={NOW + 100_000} />);
    expect(screen.getByText(/2 minutes ago/)).toBeInTheDocument();
  });
});

describe('the map groups unknown locations once', () => {
  const node = (id: string, country: string | null): TopologyNode => ({
    id,
    name: id,
    role: 'CLIENT_ORIGIN',
    country,
    overlay_ipv4: null,
    is_healthy: true,
    is_quarantined: false,
    latency_ms: null,
    compartment_id: null,
    compartment_name: '',
    is_ghost_vault: false
  });

  it('puts every device without a country in one group with the unknown label, and none in an empty group', () => {
    const layout = layoutMesh([node('a', 'IT'), node('b', null), node('c', null), node('d', 'DE')], [], 'country', {
      otherLabel: 'Location unknown'
    });
    const labels = layout.groups.map((g) => g.label).sort();
    expect(labels).toEqual(['DE', 'IT', 'Location unknown']);
    expect(layout.groups.find((g) => g.label === 'Location unknown')?.count).toBe(2);
    expect(layout.groups.every((g) => g.label !== '')).toBe(true);
  });
});
