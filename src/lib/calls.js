/**
 * Stop-times, packed.
 *
 * The network holds 3,158,637 stop-time rows. As nested arrays — one `[stop,
 * arrive, depart]` per row — they cost about 450MB of pure JavaScript object
 * overhead: each three-number array carries a header far larger than the
 * twelve bytes of payload inside it. Measured, that is 566MB of heap for the
 * services alone, and 1,358MB RSS once the index is built on top.
 *
 * Flattened into typed arrays the same rows cost 25.6MB, and heap drops to
 * 112MB. That is the difference between needing a 4GB box and running on the
 * smallest VPS anyone rents.
 *
 * Column widths come from the data, not from habit:
 *   stop index  0..189,208   -> Int32
 *   minutes     0..2,238     -> Uint16   (past midnight, so >1440 is normal)
 *
 * Rows for one service are contiguous, delimited by `offset[si]` up to
 * `offset[si + 1]` — the standard CSR layout. Nothing here allocates per row,
 * which is the entire point.
 */

/** Build the packed columns from services carrying nested `c` arrays. */
export function packCalls(services) {
  let total = 0;
  for (let i = 0; i < services.length; i++) total += services[i].c.length;

  const stop = new Int32Array(total);
  const arrive = new Uint16Array(total);
  const depart = new Uint16Array(total);
  const offset = new Int32Array(services.length + 1);

  let k = 0;
  for (let si = 0; si < services.length; si++) {
    offset[si] = k;
    const calls = services[si].c;
    for (let ci = 0; ci < calls.length; ci++) {
      const c = calls[ci];
      stop[k] = c[0];
      // A missing time is stored as its neighbour rather than as a sentinel:
      // Uint16 has no room for null, and every consumer here wants a number.
      arrive[k] = c[1] ?? c[2] ?? 0;
      depart[k] = c[2] ?? c[1] ?? 0;
      k++;
    }
  }
  offset[services.length] = k;

  return new Calls(stop, arrive, depart, offset);
}

/**
 * Column-store view over every service's stop-times.
 *
 * Reads take (service, callIndex) and resolve through `offset`, so callers
 * index exactly as they did against the nested arrays.
 */
export class Calls {
  constructor(stop, arrive, depart, offset) {
    this.stop = stop;
    this.arrive = arrive;
    this.depart = depart;
    this.offset = offset;
  }

  /** How many stops this service calls at. */
  count(si) {
    return this.offset[si + 1] - this.offset[si];
  }

  /** Stop index at call `ci` of service `si`. */
  stopAt(si, ci) {
    return this.stop[this.offset[si] + ci];
  }

  /** Arrival minute at call `ci`. */
  arriveAt(si, ci) {
    return this.arrive[this.offset[si] + ci];
  }

  /** Departure minute at call `ci`. */
  departAt(si, ci) {
    return this.depart[this.offset[si] + ci];
  }

  /**
   * The stop sequence of a service, as a view rather than a copy. Used to key
   * patterns, where copying 3.1M rows again would undo the saving.
   */
  stopsOf(si) {
    return this.stop.subarray(this.offset[si], this.offset[si + 1]);
  }

  /** Total packed rows, for accounting. */
  get rows() {
    return this.offset[this.offset.length - 1];
  }

  /** Bytes held, so the memory claim can be asserted rather than believed. */
  get bytes() {
    return this.stop.byteLength + this.arrive.byteLength
      + this.depart.byteLength + this.offset.byteLength;
  }
}
