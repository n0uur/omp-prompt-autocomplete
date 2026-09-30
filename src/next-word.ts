/**
 * Word-at-a-time acceptance of a ghost suggestion (Ctrl+→).
 *
 * Uses `Intl.Segmenter`, so scripts written without spaces (Thai, Japanese, Chinese) advance by
 * dictionary words instead of swallowing the whole suggestion.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const WHITESPACE = /^\s+$/u;

/**
 * The leading part of `text` one word-right press accepts: any leading whitespace, then either
 * one word plus the punctuation glued to it (`requests.` / `price,`), or one punctuation run
 * (`);`). Never empty for non-empty input; returns `text` whole when it has no boundary.
 */
export function nextWordOf(text: string): string {
	let end = 0;
	let started = false;
	let word = false;
	for (const { segment, isWordLike } of segmenter.segment(text)) {
		if (WHITESPACE.test(segment)) {
			if (started) break;
		} else if (isWordLike) {
			// A second word ends the chunk, even when punctuation joins them (`sum(price`).
			if (word) break;
			started = true;
			word = true;
		} else {
			started = true;
		}
		end += segment.length;
	}
	return end === 0 ? text : text.slice(0, end);
}
