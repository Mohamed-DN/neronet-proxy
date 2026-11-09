import { CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../ui/Tooltip';

/**
 * Every term id in `locales/<lang>/glossary.json` under `terms`. A test checks that
 * this list and the JSON keys match, so a term cannot be used before it is
 * defined in both languages.
 */
export const GLOSSARY_TERM_IDS = [
  'device',
  'network',
  'registration',
  'overlayAddress',
  'publicKey',
  'posture',
  'notReported',
  'attestation',
  'quarantine',
  'revoke',
  'subnetwork',
  'accessRules',
  'blockingRule',
  'rules',
  'path',
  'measuredPath',
  'networkLink',
  'signedCode',
  'peer',
  'traffic',
  'received',
  'sent',
  'responseTime',
  'responseVariation',
  'relay',
  'derp',
  'internetExit',
  'userDevice',
  'onion',
  'keyExchange',
  'contactAddress',
  'addressRange',
  'hiddenGroup',
  'group',
  'responseWindow',
  'controlServer',
  'riskScore',
  'padding',
  'connectionTest',
  'withoutAdminRights',
  'noiseScheme',
  'xchacha',
  'acl',
  'defaultDeny',
  'defaultOpen',
  'zeroTrust',
  'packetTest',
  'compiledPolicy',
  'policyVersion',
  'auditChain',
  'hmac',
  'checkpoint',
  'ed25519',
  'siem',
  'mfa',
  'recoveryCode',
  'rbac',
  'cryptoShredding',
  'dualAuthorization',
  'legalHold',
  'deadMansSwitch',
  'warrantCanary',
  'splitTunneling',
  'netmap',
  'heartbeat',
  'tenant',
  'sso',
  'pkce',
  'dns',
  'webrtc',
  'ice',
  'vcpu',
  'codec',
  'preAuthKey',
  'wireguardConfig',
  'wireguard',
  'node',
  'mebibyte'
] as const;

export type GlossaryTermId = (typeof GLOSSARY_TERM_IDS)[number];

export type GlossaryHintProps =
  | {
      /** A glossary entry: the explanation and the trigger name come from `glossary.json`. */
      term: GlossaryTermId;
      className?: string;
    }
  | {
      /** Copy the caller already translated, with the trigger's accessible name. */
      text: string;
      /** Accessible name for the trigger, e.g. "More about overlay address". */
      label: string;
      className?: string;
    };

/**
 * A small "what does this mean" trigger beside a dense label.
 *
 * The tooltip only ever adds to a fact that is already on screen in words -
 * the label it sits beside - so a touch-screen or screen-reader operator who
 * cannot reach it loses nothing but the plain-language explanation. It is a
 * real button (not a span with a hover handler), so it opens on keyboard
 * focus as well as on hover. The trigger is 24 by 24 pixels, the minimum
 * target size in the console.
 */
export function GlossaryHint(props: GlossaryHintProps) {
  const { t } = useTranslation('glossary');
  const className = props.className;

  const text = 'term' in props ? t(`terms.${props.term}.body`) : props.text;
  const label = 'term' in props ? t('ariaLabel', { term: t(`terms.${props.term}.term`) }) : props.label;

  return (
    <Tooltip content={text}>
      <button
        type="button"
        aria-label={label}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:text-content focus-visible:outline-focus ${className ?? ''}`}
      >
        <CircleHelp aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}
