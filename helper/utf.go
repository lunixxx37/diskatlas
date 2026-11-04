package main

import (
	"unicode/utf16"
	"unicode/utf8"
)

// appendUTF16 appends the UTF-16 text s to dst as UTF-8. Windows names may
// hold unpaired surrogates; they become U+FFFD, so the result is always valid
// UTF-8. (The helper keeps the original UTF-16 for listing such folders.)
func appendUTF16(dst []byte, s []uint16) []byte {
	for i := 0; i < len(s); i++ {
		c := rune(s[i])
		switch {
		case c < utf8.RuneSelf:
			dst = append(dst, byte(c))
		case utf16.IsSurrogate(c):
			if c < 0xdc00 && i+1 < len(s) {
				if r := utf16.DecodeRune(c, rune(s[i+1])); r != utf8.RuneError {
					dst = utf8.AppendRune(dst, r)
					i++
					continue
				}
			}
			dst = utf8.AppendRune(dst, utf8.RuneError)
		default:
			dst = utf8.AppendRune(dst, c)
		}
	}
	return dst
}
