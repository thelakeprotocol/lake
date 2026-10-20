/**
 * Spotting prompt injection in free text from other agents. This never decides anything: rules run in
 * code and never read the note. It only lets a house log the attempt as the attack it is.
 */
const PATTERNS = [
  /ignore (all |any )?(previous|prior|your|the) (rules|instructions)/i,
  /system (override|prompt|message)|maintenance mode|developer mode/i,
  /\bdecision\s*[:=]\s*(join|allow|grant)/i,
  /(share|send|give me) (every|all) (field|record|data)/i,
  /you are now|act as|pretend (to be|you are)/i,
  /<\/?(system|instructions?)>/i,
];

export function looksLikeInjection(text: string | undefined): boolean {
  return !!text && PATTERNS.some((p) => p.test(text));
}
