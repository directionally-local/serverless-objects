// Reading committed transactions out of a SQLite write-ahead log, and
// applying them to a copy of the database. The engine ships these pages to
// the bucket so that a database can be rebuilt from a snapshot plus the
// pages committed since (https://www.sqlite.org/fileformat.html#the_write_ahead_log).
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";

const WAL_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;
const MAGIC_LITTLE_ENDIAN = 0x377f0682;
const MAGIC_BIG_ENDIAN = 0x377f0683;

// Follows one database's WAL file. position ({ salt, offset, checksum }) is
// where the last committed transaction ended, with the checksum chain there;
// frames after it that belong to a transaction still open, or to one rolled
// back, are read again next time.
export class WalReader {
  #path;
  #position;

  constructor(walPath, position = null) {
    this.#path = walPath;
    this.#position = position;
  }

  get position() {
    return this.#position;
  }

  // The transactions committed since the last call, in order:
  // [{ pageSize, databasePages, pages: [[pageNumber, Buffer], ...] }].
  capture() {
    let fd;
    try {
      fd = openSync(this.#path, "r");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < WAL_HEADER_BYTES) return [];
      const header = Buffer.alloc(WAL_HEADER_BYTES);
      readSync(fd, header, 0, WAL_HEADER_BYTES, 0);
      const magic = header.readUInt32BE(0);
      if (magic !== MAGIC_LITTLE_ENDIAN && magic !== MAGIC_BIG_ENDIAN) return [];
      const bigEndian = magic === MAGIC_BIG_ENDIAN;
      const pageSize = header.readUInt32BE(8);
      const salt = header.subarray(16, 24).toString("hex");
      // The checksum chain starts from the header's own checksum.
      let checksum = [header.readUInt32BE(24), header.readUInt32BE(28)];
      if (walChecksum(header.subarray(0, 24), [0, 0], bigEndian).some((value, index) => value !== checksum[index])) return [];

      // A new salt means the WAL restarted after a checkpoint: read it from the top.
      let offset = WAL_HEADER_BYTES;
      if (this.#position?.salt === salt) {
        offset = this.#position.offset;
        checksum = this.#position.checksum;
      }
      const frameBytes = FRAME_HEADER_BYTES + pageSize;
      const frame = Buffer.alloc(frameBytes);
      const transactions = [];
      let pending = new Map();
      let committed = { salt, offset, checksum };
      while (offset + frameBytes <= size) {
        readSync(fd, frame, 0, frameBytes, offset);
        if (frame.subarray(8, 16).toString("hex") !== salt) break;
        checksum = walChecksum(frame.subarray(FRAME_HEADER_BYTES), walChecksum(frame.subarray(0, 8), checksum, bigEndian), bigEndian);
        if (checksum[0] !== frame.readUInt32BE(16) || checksum[1] !== frame.readUInt32BE(20)) break;
        offset += frameBytes;
        pending.set(frame.readUInt32BE(0), Buffer.from(frame.subarray(FRAME_HEADER_BYTES)));
        const databasePages = frame.readUInt32BE(4);
        if (databasePages !== 0) {
          transactions.push({ pageSize, databasePages, pages: [...pending].sort(([a], [b]) => a - b) });
          pending = new Map();
          committed = { salt, offset, checksum };
        }
      }
      this.#position = committed;
      return transactions;
    } finally {
      closeSync(fd);
    }
  }
}

// SQLite's WAL checksum: pairs of 32-bit words, in the byte order the magic number names.
function walChecksum(data, [s0, s1], bigEndian) {
  let a = s0;
  let b = s1;
  for (let index = 0; index < data.length; index += 8) {
    const x0 = bigEndian ? data.readUInt32BE(index) : data.readUInt32LE(index);
    const x1 = bigEndian ? data.readUInt32BE(index + 4) : data.readUInt32LE(index + 4);
    a = (a + x0 + b) >>> 0;
    b = (b + x1 + a) >>> 0;
  }
  return [a, b];
}

// Writes transactions' pages into a database file (one with no WAL), in order.
export function applyTransactions(databasePath, transactions) {
  const fd = openSync(databasePath, existsSync(databasePath) ? "r+" : "w+");
  try {
    for (const { pageSize, databasePages, pages } of transactions) {
      for (const [pageNumber, page] of pages) writeSync(fd, page, 0, page.length, (pageNumber - 1) * pageSize);
      ftruncateSync(fd, databasePages * pageSize);
    }
  } finally {
    closeSync(fd);
  }
}
