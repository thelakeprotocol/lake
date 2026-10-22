import { packPaths, type LakePack } from '@thelakeprotocol/core';

export { loadPacks } from '@thelakeprotocol/core';

/** Each pack's files in this pod, given the folders the Type Index names. */
export const recordPaths = (list: LakePack[], folders: Map<string, string>) => new Map(list.map((p) => [p.id, packPaths(p, folders.get(p.id))]));
