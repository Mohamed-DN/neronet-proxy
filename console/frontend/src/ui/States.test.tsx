import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Card, CardHeader } from './Card';
import { CodeText } from './CodeText';
import { PageHeader } from './PageHeader';
import { EmptyState, ErrorState, NotImplementedState, NotMeasured, Skeleton } from './States';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

describe('state surfaces', () => {
  it('keeps empty, error, not measured and not implemented apart', () => {
    renderUI(
      <div>
        <EmptyState />
        <ErrorState detail="502 from the control plane" />
        <NotImplementedState flag="cloud_pc" />
        <NotMeasured inline={false} />
      </div>
    );

    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
    expect(screen.getByText('Could not load this view')).toBeInTheDocument();
    expect(screen.getByText('Not implemented')).toBeInTheDocument();
    expect(screen.getByText('Not measured')).toBeInTheDocument();
  });

  it('shows the real failure rather than a generic apology', () => {
    renderUI(<ErrorState detail="502 from the control plane" />);
    expect(screen.getByRole('alert')).toHaveTextContent('502 from the control plane');
  });

  it('offers a retry only when there is something to retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderUI(<ErrorState />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    rerender(<ErrorState onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('names the flag that would turn an absent feature on', () => {
    renderUI(<NotImplementedState flag="cloud_pc" />);
    expect(screen.getByText('cloud_pc')).toBeInTheDocument();
  });

  it('hides the loading placeholder from a screen reader', () => {
    const { container } = renderUI(<Skeleton lines={3} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <div>
        <Skeleton lines={2} />
        <EmptyState />
        <ErrorState detail="502" onRetry={() => {}} />
        <NotImplementedState flag="cloud_pc" />
        <NotMeasured />
        <NotMeasured inline={false} />
      </div>
    );
  });
});

describe('CodeText', () => {
  it('copies the full value even when it is displayed shortened', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    const user = userEvent.setup();

    const key = 'nodekey_01H9ZXCQ4T8V2M7KPRJD3F6WYB';
    renderUI(
      <CodeText copyable truncate>
        {key}
      </CodeText>
    );

    expect(screen.getByText(/nodekey_01…/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(key);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'));
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(<CodeText copyable>100.64.0.12</CodeText>);
  });
});

describe('Card and PageHeader', () => {
  it('gives the page one level-one heading and the card a lower one', () => {
    renderUI(
      <div>
        <PageHeader title="Node matrix" description="Every enrolled node." />
        <Card>
          <CardHeader title="Reachability" description="Answered in the last minute." />
        </Card>
      </div>
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Node matrix' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Reachability' })).toBeInTheDocument();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <div>
        <PageHeader title="Node matrix" description="Every enrolled node." />
        <Card>
          <CardHeader title="Reachability" as="h2" />
        </Card>
      </div>
    );
  });
});
