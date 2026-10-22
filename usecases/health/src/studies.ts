import type { Study } from '@thelakeprotocol/core';

/** The study the demos run: do over-60s on (fictional) drug X get readmitted less? */
export function readmissionStudy(question = 'Do over-60s on drug X get readmitted less?', epsilon = 2): Study {
  return {
    v: 1,
    question,
    kind: 'contingency',
    predicates: [
      { name: 'over 60', field: 'age_band', op: 'at_least', value: 60 },
      { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' },
      { name: 'readmitted', field: 'readmissions', op: 'present' },
    ],
    privacy: { mechanism: 'unary-randomized-response', epsilon },
    minTier: 'issuer-signed',
  };
}

function cohortStudy(question: string, group: Study['predicates'][number], exposure: Study['predicates'][number], epsilon = 2): Study {
  return { ...readmissionStudy(question, epsilon), predicates: [group, exposure, { name: 'readmitted', field: 'readmissions', op: 'present' }] };
}

/** Questions the sandbox sponsor rotates through: a group, an exposure and an outcome, all certifiable. */
export const SANDBOX_STUDIES: Study[] = [
  readmissionStudy(),
  cohortStudy('Are people with heart failure on drug Y readmitted more?', { name: 'with heart failure', field: 'conditions', op: 'has_code', value: '84114007' }, { name: 'on drug Y', field: 'medications', op: 'has_code', value: 'drug-y' }),
  cohortStudy('Do over-50s on drug Z end up back in hospital?', { name: 'over 50', field: 'age_band', op: 'at_least', value: 50 }, { name: 'on drug Z', field: 'medications', op: 'has_code', value: 'drug-z' }),
  cohortStudy('Diabetes and drug X: more readmissions?', { name: 'with type 2 diabetes', field: 'conditions', op: 'has_code', value: '44054006' }, { name: 'on drug X', field: 'medications', op: 'has_code', value: 'drug-x' }),
  cohortStudy('Hypertension and drug Y: more readmissions?', { name: 'with hypertension', field: 'conditions', op: 'has_code', value: '38341003' }, { name: 'on drug Y', field: 'medications', op: 'has_code', value: 'drug-y' }),
];
