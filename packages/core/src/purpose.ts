/**
 * Purposes are a short shared list, not free words (SPEC §4). A rule that declines "marketing" has to catch
 * "advertising" too, and "totally-not-marketing" must not slip past it: so a house turns away purposes it
 * doesn't know, and a rule about a broad purpose covers the narrower ones inside it. The words follow the
 * W3C Data Privacy Vocabulary (DPV) where it has one.
 */
export interface Purpose {
  /** What the owner reads. */
  label: string;
  /** The broader purpose this one sits inside: a rule about that one covers this one. */
  within?: string;
  /** The DPV concept it corresponds to (https://w3id.org/dpv#…). */
  dpv?: string;
  /** Used to make decisions about the person (a price, a yes or no): a house warns before sensitive data goes to it. */
  decides?: boolean;
}

export const PURPOSES: Record<string, Purpose> = {
  // DPV puts commercial research inside research, so a rule about research covers both: the label says so (run 19).
  research: { label: 'research (academic or commercial)', dpv: 'ResearchAndDevelopment' },
  'academic-research': { label: 'academic research', within: 'research', dpv: 'AcademicResearch' },
  'commercial-research': { label: 'commercial research', within: 'research', dpv: 'CommercialResearch' },
  care: { label: 'care (someone looking after you)', dpv: 'ServiceProvision' },
  service: { label: 'a service you asked for', dpv: 'ServiceProvision' },
  insurance: { label: 'insurance', decides: true },
  credit: { label: 'credit and loans', dpv: 'CreditChecking', decides: true },
  marketing: { label: 'marketing', dpv: 'Marketing' },
  advertising: { label: 'advertising', within: 'marketing', dpv: 'Advertising' },
  'personalised-advertising': { label: 'personalised advertising', within: 'advertising', dpv: 'PersonalisedAdvertising' },
  'direct-marketing': { label: 'direct marketing', within: 'marketing', dpv: 'DirectMarketing' },
  security: { label: 'security', dpv: 'EnforceSecurity' },
  legal: { label: 'a legal duty', dpv: 'LegalCompliance' },
};

export const isPurpose = (p: string) => Object.hasOwn(PURPOSES, p);

/** Whether `purpose` is `broader` or sits inside it: "personalised-advertising" is within "marketing". */
export function purposeWithin(purpose: string, broader: string): boolean {
  for (let p: string | undefined = purpose, hops = 0; p && hops < 8; p = PURPOSES[p]?.within, hops++) if (p === broader) return true;
  return false;
}
