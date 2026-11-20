import { makeOffering, MAX_OFFERINGS, type Offering } from '@thelakeprotocol/core';

export interface OfferingRecord { offering: Offering; closed?: string; at: string; /** The assistant that posted it (its key). */ by?: string }

/**
 * What the owner has to sell, give away or help with (SPEC §6.9), kept in their pod: the open ones go on the house's card,
 * findable while the house is up, whoever posted them. Answers are notes to the owner, about that offering.
 */
export async function openOfferings(o: { load: () => Promise<OfferingRecord[]>; save: (list: OfferingRecord[]) => Promise<void> }) {
  let list = await o.load().catch(() => [] as OfferingRecord[]);
  let writing = Promise.resolve();
  const save = () => (writing = writing.then(() => o.save(list)).catch(() => {}));
  const live = (r: OfferingRecord) => !r.closed && Date.parse(r.offering.availabilityEnds) > Date.now();
  return {
    open: (): Offering[] => list.filter(live).map((r) => r.offering),
    all: () => list,
    find: (id: string) => list.find((r) => r.offering.id === id),
    live: (id: string) => list.some((r) => r.offering.id === id && live(r)),
    async post(input: Parameters<typeof makeOffering>[0], by?: string) {
      if (list.filter(live).length >= MAX_OFFERINGS) throw new Error(`at most ${MAX_OFFERINGS} open offerings: take one down first`);
      const offering = makeOffering(input);
      list = [...list.filter((r) => live(r) || Date.parse(r.at) > Date.now() - 30 * 86_400_000), { offering, at: new Date().toISOString(), ...(by ? { by } : {}) }].slice(-50);
      await save();
      return offering;
    },
    /** A released house (round 112): the last owner's offerings were theirs. */
    async reset() { list = []; await save(); },
    async close(id: string) {
      const r = list.find((x) => x.offering.id === id);
      if (!r || r.closed) return false;
      r.closed = new Date().toISOString();
      await save();
      return true;
    },
  };
}
export type Offerings = Awaited<ReturnType<typeof openOfferings>>;
