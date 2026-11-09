import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GLOSSARY_TERM_IDS, type GlossaryTermId } from './GlossaryHint';
import { PageFrame } from './PageFrame';
import { Input } from '../ui/Input';
import { PageHeader } from '../ui/PageHeader';
import { FilteredEmptyState } from '../ui/States';

interface Entry {
  id: GlossaryTermId;
  term: string;
  body: string;
}

/**
 * The shared glossary: every term the console uses, in one place, so a label's
 * "more about" trigger and this page give the same explanation.
 */
export default function GlossaryRoute() {
  const { t, i18n } = useTranslation('glossary');
  const [query, setQuery] = useState('');

  const entries = useMemo<Entry[]>(() => {
    const all = GLOSSARY_TERM_IDS.map((id) => ({
      id,
      term: t(`terms.${id}.term`),
      body: t(`terms.${id}.body`)
    }));
    all.sort((a, b) => a.term.localeCompare(b.term, i18n.language));
    const needle = query.trim().toLocaleLowerCase(i18n.language);
    if (!needle) return all;
    return all.filter(
      (e) =>
        e.term.toLocaleLowerCase(i18n.language).includes(needle) ||
        e.body.toLocaleLowerCase(i18n.language).includes(needle)
    );
  }, [query, t, i18n.language]);

  return (
    <PageFrame>
      <PageHeader title={t('page.title')} description={t('page.description')} />

      <div className="mt-4 max-w-md">
        <Input
          type="search"
          aria-label={t('page.search')}
          placeholder={t('page.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {entries.length === 0 ? (
        <div className="mt-6">
          <FilteredEmptyState onReset={() => setQuery('')} />
        </div>
      ) : (
        <dl className="mt-6 divide-y divide-border border-y border-border">
          {entries.map((e) => (
            <div key={e.id} className="py-3">
              <dt id={`term-${e.id}`} className="text-sm font-semibold text-content">
                {e.term}
              </dt>
              <dd className="mt-1 text-sm text-muted">{e.body}</dd>
            </div>
          ))}
        </dl>
      )}
    </PageFrame>
  );
}
