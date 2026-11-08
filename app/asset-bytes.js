export const isCompressedAsset = (url) => String(url).split('?')[0].endsWith('.cgz');

/** Decode a precompressed build asset on any static host. Dev uses its source file. */
export function readAssetBytes(response, url) {
  if (!isCompressedAsset(url)) return response.arrayBuffer();
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/** Group neighbouring byte lanes before gzip while preserving the crossing cache bit for bit. */
export function crossingBytePlanes(bytes, layout, decode = false) {
  const output = new Uint8Array(bytes.length);
  const { sideByteOffset, curbs } = layout;
  const sections = [
    [0, sideByteOffset, 12],
    [sideByteOffset, curbs.sourceByteOffset, 8],
    [curbs.sourceByteOffset, curbs.fractionByteOffset, 20],
    [curbs.fractionByteOffset, bytes.length, 16],
  ];
  for (const [start, end, stride] of sections) {
    let offset = start;
    for (let lane = 0; lane < stride; lane++) {
      let previous = 0;
      for (let index = start + lane; index < end; index += stride) {
        if (decode) {
          output[index] = previous + bytes[offset++];
          previous = output[index];
        } else {
          output[offset++] = bytes[index] - previous;
          previous = bytes[index];
        }
      }
    }
  }
  return output;
}
