// idiomorph ships no types: the one call the panel makes.
declare module 'idiomorph' {
  export const Idiomorph: {
    morph(old: Element, fresh: Element | string, options?: {
      morphStyle?: 'innerHTML' | 'outerHTML';
      ignoreActiveValue?: boolean;
      callbacks?: { afterNodeMorphed?: (old: Node, now: Node) => void; beforeAttributeUpdated?: (name: string, node: Element, mutation: 'update' | 'remove') => boolean };
    }): unknown;
  };
}
