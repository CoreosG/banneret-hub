// Banneret Hub: where to cut a tab's name when other tabs start the same way. Cutting at the end
// would show them all alike, so the name is split before the part that differs. The tab then cuts
// the middle (the end of `head`) and keeps `tail`.

/** A shorter shared start still leaves the difference in sight when the end is cut. */
const MIN_SHARED = 16;
/** What stays at the start, so the name is still recognised. */
const MIN_HEAD = 8;
/** A shorter tail ("8") says too little, so the word before it comes along. */
const MIN_TAIL = 8;
/** Further than this into one long word, the tail starts inside the word. */
const MAX_LEAD = 16;
const LEAD = 4;

const BOUNDARY = /[\s\-_./\\:·]/;

function wordStart(text: string, index: number) {
  let start = index;
  while (start > 0 && !BOUNDARY.test(text[start - 1]!)) start -= 1;
  return start;
}

function sharedStart(a: string, b: string) {
  let length = 0;
  while (length < a.length && a[length] === b[length]) length += 1;
  return length;
}

/** `head + tail` is always `title`. Null when cutting the end is enough. */
export function splitTabTitle(
  title: string,
  titles: ReadonlyArray<string>,
): { readonly head: string; readonly tail: string } | null {
  // The tabs this one could be mistaken for. Its own name, or a twin's, tells nothing apart.
  const alike = titles.filter(
    (other) => other !== title && sharedStart(title, other) >= MIN_SHARED,
  );
  if (alike.length === 0) return null;
  const differs = Math.min(
    Math.max(...alike.map((other) => sharedStart(title, other))),
    // A name that begins another one differs from it by where it ends.
    title.length - 1,
  );
  let start = wordStart(title, differs);
  if (differs - start > MAX_LEAD) start = differs - LEAD;
  // Back a word at a time until the tail says enough and no similar tab ends the same way.
  while (
    start > MIN_HEAD &&
    (title.length - start < MIN_TAIL || alike.some((other) => other.endsWith(title.slice(start))))
  ) {
    const previous = wordStart(title, start - 1);
    start = start - previous > MAX_LEAD ? start - LEAD : previous;
  }
  start = Math.max(start, MIN_HEAD);
  return { head: title.slice(0, start), tail: title.slice(start) };
}
