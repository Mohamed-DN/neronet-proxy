import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { MapEdit } from '../../../charts/TransitMap';
import { useAuth } from '../../../context/AuthContext';
import { useReorderCompartments } from '../../../services/queries';
import { useToast } from '../../../ui/Toast';
import { LineDialog } from './LineDialog';
import { MoveDialog } from './MoveDialog';
import { NewLineDialog } from './NewLineDialog';
import { SplitDialog } from './SplitDialog';
import { canEditMap, canMergeOrDelete, lineOfStations, type EditorLine } from './editorModel';
import { errorText } from './errors';

type DialogState =
  | { kind: 'line'; key: string }
  | { kind: 'move'; ids: string[]; to?: string; toLabel?: string }
  | { kind: 'split'; key: string; ids: string[] }
  | { kind: 'create'; preselected: string[] };

export interface MapEditorApi {
  /** The signed-in role may change lines (owner, admin, network_admin). */
  canEdit: boolean;
  canMergeOrDelete: boolean;
  active: boolean;
  start: () => void;
  finish: () => void;
  lines: EditorLine[];
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
  clear: () => void;
  /** The one line every chosen device is on, or null when they are on several. */
  splitSource: EditorLine | null;
  dialog: DialogState | null;
  openLine: (key: string) => void;
  openMove: (ids?: string[]) => void;
  /** Move to a line that is known by id and name (one just made, not yet in `lines`). */
  openMoveTo: (ids: string[], to: string, toLabel: string) => void;
  openSplit: () => void;
  openCreate: () => void;
  closeDialog: () => void;
  moveLine: (key: string, step: -1 | 1) => Promise<void>;
  /** What the map needs to draw itself in edit mode. */
  mapEdit: MapEdit;
  /** Where focus goes when editing ends: the button that started it. */
  enterRef: React.RefObject<HTMLButtonElement>;
}

/** The signed-in user, or null where there is no session provider (a page rendered on its own). */
function useOptionalUser() {
  try {
    return useAuth().user;
  } catch {
    return null;
  }
}

/** Puts focus on an element that is drawn a moment later (the map re-lays out after a change). */
function focusLater(selector: string, fallback?: string) {
  const attempt = (triesLeft: number) => {
    const target =
      document.querySelector<HTMLElement>(selector) ??
      (triesLeft === 0 && fallback ? document.querySelector<HTMLElement>(fallback) : null);
    if (target) target.focus();
    else if (triesLeft > 0) window.setTimeout(() => attempt(triesLeft - 1), 60);
  };
  window.setTimeout(() => attempt(8), 0);
}

/**
 * The state of the map editor: whether it is on, which devices are chosen, which dialog is open.
 * The map and the list draw from it, so the two stay one editor. The role is read here, once.
 */
export function useMapEditor(lines: EditorLine[]): MapEditorApi {
  const { t } = useTranslation('mapEditor');
  const { notify } = useToast();
  const user = useOptionalUser();
  const canEdit = canEditMap(user);
  const mayMerge = canMergeOrDelete(user);

  const [active, setActive] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const reorder = useReorderCompartments();

  // A role that loses the right (or a sign-out) ends the editing.
  const editing = active && canEdit;

  const lineOf = useMemo(() => lineOfStations(lines), [lines]);
  // Devices that left the inventory (or a line change that removed them) drop out of the choice.
  const selected = useMemo(() => new Set([...chosen].filter((id) => lineOf.has(id))), [chosen, lineOf]);

  const start = useCallback(() => setActive(true), []);
  const clear = useCallback(() => setChosen(new Set()), []);
  const finish = useCallback(() => {
    setActive(false);
    setChosen(new Set());
    setDialog(null);
    focusLater('[data-map-editor-enter]');
  }, []);
  const toggle = useCallback((id: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const splitSource = useMemo(() => {
    const sources = new Set([...selected].map((id) => lineOf.get(id)?.key));
    if (sources.size !== 1) return null;
    const line = lineOf.get([...selected][0]!);
    return line && line.id ? line : null;
  }, [selected, lineOf]);

  const editable = useMemo(() => lines.filter((line) => line.id !== null), [lines]);

  const saveOrder = useCallback(
    async (ids: string[]) => {
      try {
        await reorder.mutateAsync(ids);
        notify(t('toast.reordered'), { tone: 'success' });
      } catch (error) {
        notify(t('toast.failed', { message: errorText(t, error) }), { tone: 'danger' });
      }
    },
    [reorder, notify, t]
  );

  const moveLine = useCallback(
    async (key: string, step: -1 | 1) => {
      const ids = editable.map((line) => line.id!);
      const from = editable.findIndex((line) => line.key === key);
      const to = from + step;
      if (from < 0 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to]!, ids[from]!];
      await saveOrder(ids);
    },
    [editable, saveOrder]
  );

  const dropLine = useCallback(
    (key: string, ontoKey: string) => {
      const ids = editable.map((line) => line.id!);
      const from = editable.findIndex((line) => line.key === key);
      const to = editable.findIndex((line) => line.key === ontoKey);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved!);
      void saveOrder(ids);
    },
    [editable, saveOrder]
  );

  const openLine = useCallback((key: string) => setDialog({ kind: 'line', key }), []);
  const openMove = useCallback((ids?: string[]) => setDialog({ kind: 'move', ids: ids ?? [...selected] }), [selected]);
  const openMoveTo = useCallback(
    (ids: string[], to: string, toLabel: string) => setDialog({ kind: 'move', ids, to, toLabel }),
    []
  );
  const openSplit = useCallback(() => {
    if (splitSource) setDialog({ kind: 'split', key: splitSource.key, ids: [...selected] });
  }, [splitSource, selected]);
  const openCreate = useCallback(() => setDialog({ kind: 'create', preselected: [...selected] }), [selected]);
  const closeDialog = useCallback(() => setDialog(null), []);

  const dropStations = useCallback(
    (ids: string[], lineKey: string) => {
      const target = lines.find((line) => line.key === lineKey);
      if (!target?.id) return;
      // Dropping a device on the line it is already on changes nothing.
      const moving = ids.filter((id) => lineOf.get(id)?.key !== lineKey && lineOf.has(id));
      if (moving.length > 0) setDialog({ kind: 'move', ids: moving, to: target.id });
    },
    [lines, lineOf]
  );

  const mapEdit = useMemo<MapEdit>(
    () => ({
      selected,
      onToggleStation: toggle,
      onOpenLine: openLine,
      onDropStations: dropStations,
      onDropLine: dropLine,
      droppable: new Set(editable.map((line) => line.key)),
      labels: {
        line: (heading) => t('line.edit', { name: heading }),
        station: (description, isChosen) =>
          isChosen ? t('station.chosen', { description }) : t('station.notChosen', { description }),
        empty: t('line.empty')
      }
    }),
    [selected, toggle, openLine, dropStations, dropLine, editable, t]
  );

  // Editing ends when the role no longer allows it.
  useEffect(() => {
    if (active && !canEdit) setActive(false);
  }, [active, canEdit]);

  return {
    canEdit,
    canMergeOrDelete: mayMerge,
    active: editing,
    start,
    finish,
    lines,
    selected,
    toggle,
    clear,
    splitSource,
    dialog,
    openLine,
    openMove,
    openMoveTo,
    openSplit,
    openCreate,
    closeDialog,
    moveLine,
    mapEdit,
    enterRef
  };
}

/** The dialog that is open, if any. Draws nothing otherwise. */
export function MapEditorDialogs({ api }: { api: MapEditorApi }) {
  const { dialog, lines } = api;
  if (!api.active || !dialog) return null;

  const done = (focus: string | null, fallback?: string) => {
    api.closeDialog();
    if (focus) focusLater(focus, fallback);
  };

  if (dialog.kind === 'line') {
    const line = lines.find((candidate) => candidate.key === dialog.key);
    if (!line) return null;
    return (
      <LineDialog
        line={line}
        lines={lines}
        canMergeOrDelete={api.canMergeOrDelete}
        onMove={api.moveLine}
        onClose={() => {
          api.closeDialog();
          // The line may be gone (merged, deleted); then focus falls back to the editing bar.
          focusLater(
            `[data-line-heading="${dialog.key}"], [data-editor-line="${dialog.key}"]`,
            '[data-map-editor-done]'
          );
        }}
      />
    );
  }

  if (dialog.kind === 'move') {
    return (
      <MoveDialog
        ids={dialog.ids}
        to={dialog.to}
        toLabel={dialog.toLabel}
        lines={lines}
        onClose={(moved) => {
          if (moved) {
            api.clear();
            done(
              `[data-station-id="${moved.ids[0]}"], [data-editor-station="${moved.ids[0]}"]`,
              '[data-map-editor-done]'
            );
          } else api.closeDialog();
        }}
      />
    );
  }

  if (dialog.kind === 'split') {
    const source = lines.find((line) => line.key === dialog.key);
    if (!source) return null;
    return (
      <SplitDialog
        source={source}
        ids={dialog.ids}
        onClose={(created) => {
          if (created) {
            api.clear();
            done(`[data-line-heading="${created.id}"], [data-editor-line="${created.id}"]`, '[data-map-editor-done]');
          } else api.closeDialog();
        }}
      />
    );
  }

  return (
    <NewLineDialog
      lines={lines}
      preselected={dialog.preselected}
      onClose={(created) => {
        if (created && created.ids.length > 0) {
          // The devices still have to be moved, and that is previewed like any other move.
          api.clear();
          api.openMoveTo(created.ids, created.id, created.name);
          return;
        }
        if (created)
          done(`[data-line-heading="${created.id}"], [data-editor-line="${created.id}"]`, '[data-map-editor-done]');
        else api.closeDialog();
      }}
    />
  );
}
