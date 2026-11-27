const roomByteLimit = 48 * 1024 * 1024;
export function roomCache(limit = roomByteLimit) {
  const pictures = new Map<string, OffscreenCanvas>();
  let bytes = 0;
  return {
    get(key: string, build: () => OffscreenCanvas) {
      let picture = pictures.get(key);
      if (picture) pictures.delete(key);
      else {
        picture = build();
        bytes += picture.width * picture.height * 4;
      }
      pictures.set(key, picture);
      while (bytes > limit) {
        const first = pictures.entries().next().value!;
        pictures.delete(first[0]);
        bytes -= first[1].width * first[1].height * 4;
      }
      return picture;
    },
    get bytes() {
      return bytes;
    },
  };
}
