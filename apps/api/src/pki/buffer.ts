/** Converte Buffer em ArrayBuffer exato (fatiando o pool) — exigência dos tipos TS5.7/pkijs. */
export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
