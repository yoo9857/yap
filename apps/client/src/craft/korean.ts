/**
 * Korean object-particle selection. Pure, so it can be unit-tested.
 *
 * 을 follows a syllable that ends in a consonant, 를 one that does not —
 * "기린을" but "판다를". Hard-coding either one is wrong for half the pet
 * roster and reads as broken Korean, which is worse in a children's app than
 * in most places.
 *
 * Hangul syllables occupy U+AC00–U+D7A3 and are laid out so that
 * `(code - 0xAC00) % 28` is the final-consonant index, 0 meaning none. Names
 * that do not end in a Hangul syllable (a digit, a Latin letter, an emoji)
 * have no reliable rule, so they take 를, which is the gentler mistake.
 */
export function objectParticle(word: string): "을" | "를" {
  const code = word.codePointAt(word.length - 1) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return "를";
  return (code - 0xac00) % 28 === 0 ? "를" : "을";
}

/** `"기린" → "기린을"`. */
export const withObjectParticle = (word: string): string => `${word}${objectParticle(word)}`;
