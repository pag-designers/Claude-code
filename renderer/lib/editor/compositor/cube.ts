/** Adobe/Resolve `.cube` 3D LUT parser. Pure — no DOM. */

export const MAX_LUT_SIZE = 65;

/**
 * Parses a `.cube` file into `size³` RGB float triples, red index fastest (the file order, which is also the layout
 * `texImage3D` wants for x = R, y = G, z = B). Supports `TITLE`, comments, `LUT_3D_SIZE` (2..65), `DOMAIN_MIN/MAX` of
 * 0..1 (anything else is rejected rather than silently mis-mapped). 1D LUTs are rejected.
 */
export function parseCube(text: string): { size: number; data: Float32Array } {
  let size = 0;
  const values: number[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = (lines[ln] ?? '').replace(/#.*$/, '').trim();
    if (line === '') continue;
    const first = line.charCodeAt(0);
    const isNumberLine = (first >= 48 && first <= 57) || first === 45 || first === 43 || first === 46;
    if (isNumberLine) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) throw new Error(`.cube line ${ln + 1}: expected 3 numbers`);
      for (let i = 0; i < 3; i++) {
        const v = Number(parts[i]);
        if (!Number.isFinite(v)) throw new Error(`.cube line ${ln + 1}: bad number "${parts[i]}"`);
        values.push(v);
      }
      continue;
    }
    const [key = '', ...rest] = line.split(/\s+/);
    switch (key.toUpperCase()) {
      case 'TITLE':
        break;
      case 'LUT_3D_SIZE': {
        const n = Number(rest[0]);
        if (!Number.isInteger(n) || n < 2 || n > MAX_LUT_SIZE)
          throw new Error(`.cube: LUT_3D_SIZE must be an integer 2..${MAX_LUT_SIZE}`);
        size = n;
        break;
      }
      case 'LUT_1D_SIZE':
      case 'LUT_1D_INPUT_RANGE':
        throw new Error('.cube: 1D LUTs are not supported');
      case 'LUT_3D_INPUT_RANGE':
      case 'DOMAIN_MIN':
      case 'DOMAIN_MAX': {
        const want = key.toUpperCase() === 'DOMAIN_MIN' ? 0 : 1;
        const nums = rest.map(Number);
        const ok =
          key.toUpperCase() === 'LUT_3D_INPUT_RANGE'
            ? nums.length >= 2 && nums[0] === 0 && nums[1] === 1
            : nums.length >= 3 && nums.slice(0, 3).every((v) => v === want);
        if (!ok) throw new Error(`.cube: only a 0..1 input domain is supported (${key})`);
        break;
      }
      default:
        throw new Error(`.cube line ${ln + 1}: unknown keyword "${key}"`);
    }
  }
  if (size === 0) throw new Error('.cube: missing LUT_3D_SIZE');
  const expected = size * size * size * 3;
  if (values.length !== expected)
    throw new Error(`.cube: expected ${expected / 3} entries for size ${size}, found ${values.length / 3}`);
  return { size, data: Float32Array.from(values) };
}
