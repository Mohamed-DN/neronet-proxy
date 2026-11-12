import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useAuth } from '../context/AuthContext';
import { useCreateRegistrationKey } from '../services/queries/devices';
import { ROUTES } from '../routes/paths';
import { canAddAgentDevice, effectiveRole } from '../services/roles';
import { Button, CodeText, Dialog } from '../ui';
import { cn } from '../ui/cn';

export interface AddDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Choice = 'profile' | 'agent';

interface ChoiceProps {
  value: Choice;
  checked: boolean;
  title: string;
  body: string;
  onSelect: (value: Choice) => void;
}

/** One radio in the list. The name and the explanation both belong to the radio. */
function ChoiceOption({ value, checked, title, body, onSelect }: ChoiceProps) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-control border p-3 transition-colors',
        checked ? 'border-accent bg-accent/5' : 'border-border hover:bg-surface-hover'
      )}
    >
      <input
        type="radio"
        name="device-kind"
        value={value}
        checked={checked}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onChange={() => onSelect(value)}
        className="mt-1 h-4 w-4 shrink-0 accent-accent focus-visible:outline-focus"
      />
      <span className="min-w-0 space-y-1">
        <span id={titleId} className="block text-body font-medium text-content">
          {title}
        </span>
        <span id={bodyId} className="block text-caption text-muted">
          {body}
        </span>
      </span>
    </label>
  );
}

/**
 * The "Add device" choice. A phone or computer is added from the user portal,
 * where the browser makes its keys. A server or computer with the NeroNet agent
 * is given a one-time registration key here; only the roles the server lets
 * create one see that choice.
 */
export default function AddDeviceDialog({ open, onOpenChange }: AddDeviceDialogProps) {
  const { t } = useTranslation('devices');
  const { user } = useAuth();
  const role = effectiveRole(user);
  const agentAllowed = canAddAgentDevice(role);
  const [choice, setChoice] = useState<Choice>('profile');
  const createKey = useCreateRegistrationKey();
  const key = createKey.data?.enrolment_string;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('devices.title')}
      description={t('devices.description')}
      size="md"
    >
      <div role="radiogroup" aria-label={t('devices.title')} className="space-y-2">
        <ChoiceOption
          value="profile"
          checked={choice === 'profile'}
          title={t('devices.profile.title')}
          body={t('devices.profile.body')}
          onSelect={setChoice}
        />
        {agentAllowed && (
          <ChoiceOption
            value="agent"
            checked={choice === 'agent'}
            title={t('devices.agent.title')}
            body={t('devices.agent.body')}
            onSelect={setChoice}
          />
        )}
      </div>

      <div className="mt-4 space-y-3">
        {choice === 'profile' ? (
          <Link
            to={ROUTES.meAdd}
            className="inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-4 text-body font-medium text-accent-contrast transition-colors hover:bg-accent-strong focus-visible:outline-focus"
          >
            {t('devices.profile.go')}
          </Link>
        ) : (
          <>
            <Button variant="primary" loading={createKey.isPending} onClick={() => createKey.mutate()}>
              {t('devices.agent.create')}
            </Button>

            {createKey.isError && (
              <p role="alert" className="text-caption text-danger">
                {t('devices.agent.failed')}
              </p>
            )}

            {key && (
              <div className="space-y-2">
                <CodeText copyable>{`SOVEREIGN_ENROLMENT_KEY=${key}`}</CodeText>
                <p className="text-caption text-content">{t('devices.agent.howTo')}</p>
                <p className="text-caption text-muted">{t('devices.agent.expiry')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
