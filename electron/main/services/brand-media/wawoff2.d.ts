declare module 'wawoff2' {
  export function compress(data: Uint8Array): Promise<Uint8Array>;
  export function decompress(data: Uint8Array): Promise<Uint8Array>;
}

declare module 'wawoff2/decompress' {
  const decompress: (data: Uint8Array) => Promise<Uint8Array>;
  export default decompress;
}
