import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * The control plane seeds each organisation's first sub-network (the database
 * calls it a compartment) with the English name below and the slug "default".
 * That is a row's raw value, not something to show a person: this is the one
 * place that recognises it and says which words replace it.
 */

/** The name the control plane gives the default sub-network (migration 019, CompartmentService). */
export const DEFAULT_COMPARTMENT_NAME = 'Default Compartment';

interface CompartmentLike {
  name?: string | null;
  slug?: string | null;
}

/** True for the organisation's default sub-network, by slug when the row has one and by seeded name otherwise. */
export function isDefaultCompartment({ name, slug }: CompartmentLike): boolean {
  return slug === 'default' || (!slug && name === DEFAULT_COMPARTMENT_NAME);
}

/** The words to show for a sub-network: the translated label for the default, the operator's own name otherwise. */
export function compartmentLabel(compartment: CompartmentLike, defaultLabel: string): string {
  return isDefaultCompartment(compartment) ? defaultLabel : (compartment.name ?? '');
}

/** `(compartment) => label` in the reader's language. */
export function useCompartmentLabel(): (compartment: CompartmentLike) => string {
  const { t } = useTranslation('ui');
  const defaultLabel = t('compartment.default');
  return useCallback((compartment) => compartmentLabel(compartment, defaultLabel), [defaultLabel]);
}
