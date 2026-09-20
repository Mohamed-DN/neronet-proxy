import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from './Badge';
import { Stat } from './Stat';
import { StatusBadge, type Status } from './StatusBadge';
import { isNotMeasured, stateOf } from './dataState';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

describe('StatusBadge', () => {
  it('carries a word and an icon, not colour alone', () => {
    const { container } = renderUI(<StatusBadge status="critical" />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('keeps the word available to a reader in the compact form', () => {
    renderUI(<StatusBadge status="warning" compact />);
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toHaveClass('sr-only');
  });

  it('distinguishes a value that is unknown from one that was never measured', () => {
    const { rerender } = renderUI(<StatusBadge status="unknown" />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();

    rerender(<StatusBadge status="not-measured" />);
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('never renders a missing status as a healthy one', () => {
    const statuses: Status[] = ['ok', 'warning', 'critical', 'unknown', 'not-measured'];
    const { container } = renderUI(
      <div>
        {statuses.map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </div>
    );
    const rendered = [...container.querySelectorAll('[data-status]')].map((node) => node.getAttribute('data-status'));
    expect(rendered).toEqual(statuses);
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <div>
        <StatusBadge status="ok" />
        <StatusBadge status="warning" />
        <StatusBadge status="critical" />
        <StatusBadge status="unknown" />
        <StatusBadge status="not-measured" />
        <StatusBadge status="ok" compact />
      </div>
    );
  });
});

describe('Stat', () => {
  it('renders a measurement with its unit', () => {
    renderUI(<Stat label="Enrolled nodes" value={42} unit="nodes" />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('nodes')).toBeInTheDocument();
  });

  it('renders null as Not measured and never as zero', () => {
    renderUI(<Stat label="Circuits built" value={null} unit="circuits" />);
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('circuits')).not.toBeInTheDocument();
  });

  it('renders undefined and NaN as Not measured too', () => {
    const { rerender } = renderUI(<Stat label="Throughput" value={undefined} />);
    expect(screen.getByText('Not measured')).toBeInTheDocument();

    rerender(<Stat label="Throughput" value={Number.NaN} />);
    expect(screen.getByText('Not measured')).toBeInTheDocument();
  });

  it('still renders a real zero as zero', () => {
    renderUI(<Stat label="Quarantined nodes" value={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('Not measured')).not.toBeInTheDocument();
  });

  it('drops the delta when the value itself was never measured', () => {
    renderUI(<Stat label="Throughput" value={null} delta={{ value: 12, label: '+12%' }} />);
    expect(screen.queryByText('+12%')).not.toBeInTheDocument();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <div>
        <Stat label="Enrolled nodes" value={42} unit="nodes" delta={{ value: 3, label: '+3' }} />
        <Stat label="Circuits built" value={null} />
      </div>
    );
  });
});

describe('stateOf', () => {
  it('classifies only absent values as not measured', () => {
    expect(stateOf(null)).toBe('not-measured');
    expect(stateOf(undefined)).toBe('not-measured');
    expect(stateOf(Number.NaN)).toBe('not-measured');
    expect(stateOf(0)).toBe('ok');
    expect(stateOf('')).toBe('ok');
    expect(stateOf(false)).toBe('ok');
    expect(isNotMeasured(0)).toBe(false);
  });
});

describe('Badge', () => {
  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <div>
        <Badge>v4.0</Badge>
        <Badge tone="accent" mono>
          Ed25519
        </Badge>
        <Badge tone="danger">3-tier</Badge>
      </div>
    );
  });
});
