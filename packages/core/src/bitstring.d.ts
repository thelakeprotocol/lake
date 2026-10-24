// @digitalbazaar/bitstring ships without types: the part the status list uses.
declare module '@digitalbazaar/bitstring' {
  export class Bitstring {
    constructor(o: { length?: number; buffer?: Uint8Array; leftToRightIndexing?: boolean });
    length: number;
    set(position: number, on: boolean): void;
    get(position: number): boolean;
    encodeBits(): Promise<string>;
    static decodeBits(o: { encoded: string }): Promise<Uint8Array>;
  }
}
