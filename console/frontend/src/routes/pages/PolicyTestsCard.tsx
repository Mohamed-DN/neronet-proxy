import { Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useDeletePolicyTest, usePolicyTests, useRunPolicyTests } from '../../services/queries';
import type { AclPolicyTestFailure } from '../../services/types';
import { Badge, Button, Card, CardHeader, EmptyState, IconButton } from '../../ui';

/**
 * The assertions every ACL save is checked against (ADR 0028), on the ACL page itself
 * rather than in a modal: an administrator should see what a save will be judged by
 * before making it.
 */
export function PolicyTestsCard({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation('ui');
  const { data: tests = [] } = usePolicyTests();
  const deleteTest = useDeletePolicyTest();
  const runTests = useRunPolicyTests();
  const run = runTests.data;

  return (
    <Card data-testid="policy-tests-card">
      <CardHeader as="h2" title={t('acl.policyTests.title')} description={t('acl.policyTests.description')} />
      {tests.length === 0 ? (
        <EmptyState title={t('acl.policyTests.empty')} />
      ) : (
        <ul className="divide-y divide-border/60 text-xs font-mono">
          {tests.map((test) => (
            <li key={test.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">
                {test.source_ip} → {test.destination_ip} {test.protocol}/{test.port}
                {test.description ? <span className="ml-2 text-muted font-sans">{test.description}</span> : null}
              </span>
              <span className="flex items-center gap-2 flex-shrink-0">
                <Badge tone={test.expect === 'ACCEPT' ? 'success' : 'danger'}>
                  {t('acl.policyTests.expects', { verdict: test.expect })}
                </Badge>
                {canManage && (
                  <IconButton
                    icon={Trash2}
                    label={t('acl.policyTests.delete')}
                    variant="danger"
                    size="sm"
                    onClick={() => deleteTest.mutate(test.id)}
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
          onClick={() => runTests.mutate()}
          loading={runTests.isPending}
          disabled={tests.length === 0}
          data-testid="run-policy-tests"
        >
          <Play className="w-4 h-4 mr-2" />
          <span>{t('acl.policyTests.run')}</span>
        </Button>
        {run && (
          <span
            className={`text-xs font-mono ${run.failures.length === 0 ? 'text-success' : 'text-danger'}`}
            data-testid="policy-tests-run-result"
            role="status"
          >
            {t('acl.policyTests.runResult', { passed: run.total - run.failures.length, total: run.total })}
          </span>
        )}
      </div>
      {run && run.failures.length > 0 && <PolicyTestFailures failures={run.failures} />}
    </Card>
  );
}

/** The assertions a save would break, as the server listed them. */
export function PolicyTestFailures({ failures, title }: { failures: AclPolicyTestFailure[]; title?: string }) {
  const { t } = useTranslation('ui');
  return (
    <div
      className="p-3 rounded-lg bg-danger/10 border border-danger/30 text-xs text-danger space-y-1"
      data-testid="policy-test-failures"
      role="alert"
    >
      {title && <p className="font-bold">{title}</p>}
      <ul className="space-y-1 font-mono">
        {failures.map((f, i) => (
          <li key={`${f.test_id ?? 'candidate'}-${f.organization_id}-${i}`}>
            {t('acl.policyTests.failureLine', {
              src: f.source_ip,
              dst: f.destination_ip,
              proto: f.protocol,
              port: f.port,
              expect: f.expect,
              got: f.got
            })}
            {f.description ? <span className="ml-2 font-sans">({f.description})</span> : null}
            <span className="ml-2 font-sans text-muted">
              {t('acl.policyTests.organization', { org: f.organization_id })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
