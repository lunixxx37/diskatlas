/** Forms of a counted phrase; "#" stands for the formatted number ("# file" / "# files"). */
export interface Plural {
  one: string;
  other: string;
}

/** Text with bold parts, for sentences that emphasise a few words. */
export type Rich = ReadonlyArray<string | { b: string }>;
