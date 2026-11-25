import { PastedRange } from '../types';

const MAX_LCS_CELLS = 250_000;

/** Longueurs du préfixe et du suffixe communs (sans chevauchement). */
function commonEdges(a: string, b: string) {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/** Découpe en mots et blancs, ou en lignes (retours à la ligne inclus). */
const words = (text: string) => text.match(/\s+|\S+/g) ?? [];
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * Plages de `current` qui ne figurent pas dans `saved` : le texte ajouté ou modifié depuis la
 * dernière sauvegarde (affiché en orange). Les suppressions n'ont rien à colorer.
 */
export function getUnsavedRanges(saved: string, current: string): PastedRange[] {
  if (saved === current) return [];
  const { prefix, suffix } = commonEdges(saved, current);
  const oldMid = saved.slice(prefix, saved.length - suffix);
  const newMid = current.slice(prefix, current.length - suffix);
  if (!newMid) return [];
  if (!oldMid) return [{ start: prefix, end: prefix + newMid.length }];

  // Plusieurs modifications éloignées : diff par mots (ou par lignes pour un long passage)
  // pour ne pas colorer ce qui n'a pas changé entre elles.
  let a = words(oldMid);
  let b = words(newMid);
  if (a.length * b.length > MAX_LCS_CELLS) {
    a = lines(oldMid);
    b = lines(newMid);
  }
  if (a.length * b.length > MAX_LCS_CELLS) return [{ start: prefix, end: prefix + newMid.length }];
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ranges: PastedRange[] = [];
  let i = 0;
  let j = 0;
  let pos = prefix;
  let removed = '';
  let added = '';
  let addedStart = pos;
  const flush = () => {
    if (added) {
      const edges = commonEdges(removed, added);
      const start = addedStart + edges.prefix;
      const end = addedStart + added.length - edges.suffix;
      if (end > start) {
        const last = ranges[ranges.length - 1];
        if (last && last.end === start) last.end = end;
        else ranges.push({ start, end });
      }
    }
    removed = '';
    added = '';
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      pos += b[j].length;
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      if (!added) addedStart = pos;
      added += b[j];
      pos += b[j].length;
      j++;
    } else {
      removed += a[i];
      i++;
    }
  }
  flush();
  return ranges;
}
