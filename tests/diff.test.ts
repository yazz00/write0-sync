import { describe, expect, it } from 'vitest';
import { getUnsavedRanges } from '../sync/diff';

/** Texte couvert par les plages (pour des assertions lisibles). */
const marked = (text: string, saved: string) =>
  getUnsavedRanges(saved, text).map((r) => text.slice(r.start, r.end));

describe('texte non enregistré (orange)', () => {
  it('ne marque rien quand tout est enregistré', () => {
    expect(getUnsavedRanges('abc', 'abc')).toEqual([]);
  });

  it('marque tout un document jamais enregistré', () => {
    expect(marked('Bonjour', '')).toEqual(['Bonjour']);
  });

  it('marque seulement la frappe ajoutée', () => {
    expect(marked('Il fait beau aujourd’hui.', 'Il fait beau.')).toEqual([' aujourd’hui']);
  });

  it('ne marque rien pour une simple suppression', () => {
    expect(getUnsavedRanges('Il fait très beau.', 'Il fait beau.')).toEqual([]);
  });

  it('marque deux modifications éloignées sans colorer le texte entre elles', () => {
    const saved =
      'Premier paragraphe.\n\nUn long passage inchangé au milieu.\n\nDernier paragraphe.';
    const text =
      'Premier paragraphe modifié.\n\nUn long passage inchangé au milieu.\n\nDernier paragraphe, aussi.';
    expect(marked(text, saved)).toEqual([' modifié', ', aussi']);
  });

  it('marque un mot remplacé', () => {
    expect(marked('Le chat dort.', 'Le chien dort.')).toEqual(['at']);
  });
});
