import { useEffect, useState } from 'react';
import { Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useDeletePolicyTest, usePolicyTests, useRunPolicyTests } from '../../services/queries';
import type { AclPolicyTest, AclPolicyTestFailure } from '../../services/types';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, IconButton } from '../../ui';

/** "100.64.1.2 to 100.64.1.3, TCP port 443": how a test's packet reads aloud and on screen. */
function packetLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  p: { source_ip: string; destination_ip: string; protocol: string; port: number }
) {
  return t('policyTests.packet', { src: p.source_ip, dst: p.destination_ip, proto: p.protocol, port: p.port });
}

/**
 * The assertions every ACL save is checked against (ADR 0028). It sits under the rules
 * it judges: the rules are the working data, the tests are the promise they must keep.
 */
export function PolicyTestsCard({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation(['acl', 'ui']);
  const { data: tests = [] } = usePolicyTests();
  const deleteTest = useDeletePolicyTest();
  const runTests = useRunPolicyTests();
  const [deleteTarget, setDeleteTarget] = useState<AclPolicyTest | null>(null);
  const run = runTests.data;

  // A result describes the tests it ran; once the list changes it no longer does.
  const testIds = tests.map((x) => x.id).join(',');
  useEffect(() => {
    runTests.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testIds]);

  const verdict = (v: 'ACCEPT' | 'DROP') => (v === 'ACCEPT' ? t('policyTests.accepted') : t('policyTests.dropped'));
  const runText = run ? t('policyTests.runResult', { passed: run.total - run.failures.length, total: run.total }) : '';

  return (
    <Card data-testid="policy-tests-card">
      <CardHeader as="h2" title={t('policyTests.title')} description={t('policyTests.description')} />
      {tests.length === 0 ? (
        <EmptyState title={t('policyTests.empty')} body={t('policyTests.emptyBody')} />
      ) : (
        <ul className="divide-y divide-border/60 text-xs">
          {tests.map((test) => (
            <li key={test.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">
                <span className="font-mono">{packetLabel(t, test)}</span>
                {test.description ? <span className="ml-2 text-muted">{test.description}</span> : null}
              </span>
              <span className="flex items-center gap-2 flex-shrink-0">
                <Badge tone={test.expect === 'ACCEPT' ? 'success' : 'danger'}>
                  {t('policyTests.expects', { verdict: verdict(test.expect) })}
                </Badge>
                {canManage && (
                  <IconButton
                    icon={Trash2}
                    label={t('policyTests.deleteNamed', { packet: packetLabel(t, test) })}
                    variant="danger"
                    size="sm"
                    onClick={() => setDeleteTarget(test)}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-3">
        <Button
          variant="secondary"
          icon={Play}
          onClick={() => runTests.mutate()}
          loading={runTests.isPending}
          loadingLabel={t('policyTests.running')}
          disabled={tests.length === 0}
          data-testid="run-policy-tests"
        >
          {t('policyTests.run')}
        </Button>
        {/* Always mounted, so a screen reader hears the result when it arrives. */}
        <span
          role="status"
          aria-live="polite"
          className={`text-xs font-mono ${run && run.failures.length > 0 ? 'text-danger' : 'text-success'}`}
          data-testid={run ? 'policy-tests-run-result' : undefined}
        >
          {runText}
        </span>
      </div>
      {run && run.failures.length > 0 && <PolicyTestFailures failures={run.failures} announce={false} />}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('policyTests.deleteTitle')}
        description={deleteTarget ? packetLabel(t, deleteTarget) : ''}
        confirmLabel={t('policyTests.deleteConfirm')}
        tone="danger"
        busy={deleteTest.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteTest.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </Card>
  );
}

/**
 * The assertions a save would break, as the server listed them. `announce` is for the
 * refused save, which interrupts; a run's failures are already announced by its status.
 */
export function PolicyTestFailures({
  failures,
  title,
  announce = true
}: {
  failures: AclPolicyTestFailure[];
  title?: string;
  announce?: boolean;
}) {
  const { t } = useTranslation(['acl', 'ui']);
  const verdict = (v: string) => (v === 'ACCEPT' ? t('policyTests.accepted') : t('policyTests.dropped'));
  return (
    <div
      className="mt-3 p-3 rounded-lg bg-danger/10 border border-danger/30 text-xs text-danger space-y-1"
      data-testid="policy-test-failures"
      role={announce ? 'alert' : undefined}
    >
      <p className="font-bold">{title ?? t('policyTests.failuresTitle')}</p>
      <ul className="space-y-1">
        {failures.map((f, i) => (
          <li key={`${f.test_id ?? 'candidate'}-${f.organization_id}-${i}`}>
            {t('policyTests.failureLine', {
              packet: packetLabel(t, f),
              expect: verdict(f.expect),
              got: verdict(f.got)
            })}
            {f.description ? `, ${f.description}` : ''}
            <span className="text-muted">{`. ${t('policyTests.organization', { org: f.organization_id })}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
