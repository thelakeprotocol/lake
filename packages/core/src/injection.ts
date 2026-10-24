/**
 * Spotting prompt injection in free text from other agents. This never decides anything: rules run in
 * code and never read the note. It only lets a house log the attempt as the attack it is.
 */
const PATTERNS = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(rules|instructions|guidelines|polic(y|ies)|settings)\b/i,
  // Claiming the owner already said yes: only the owner's own device can (run 11's polite injection).
  /\b(the |your )?owner\b.{0,20}\b(has|have|had)?\s*(already )?(approved|authori[sz]ed|consented|agreed|allowed)\b/i,
  /system (override|prompt|message)|maintenance mode|developer mode/i,
  /\bdecision\s*[:=]\s*(join|allow|grant)/i,
  /(share|send|give me) (every|all) (field|record|data)/i,
  /you are now|act as|pretend (to be|you are)/i,
  /<\/?(system|instructions?)>/i,
];

export function looksLikeInjection(text: string | undefined): boolean {
  return !!text && PATTERNS.some((p) => p.test(text));
}
