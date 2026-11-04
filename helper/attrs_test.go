package main

import (
	"testing"
	"time"
	"unicode/utf16"
)

func TestClassify(t *testing.T) {
	const (
		archive    = 0x20
		hidden     = 0x2
		pinned     = 0x80000
		unpinned   = 0x100000
		tagCloud   = 0x9000001a // IO_REPARSE_TAG_CLOUD (one of the 0x9000x01A family)
		tagCloud6  = 0x9000601a
		tagJunct   = 0xa0000003 // IO_REPARSE_TAG_MOUNT_POINT
		tagSymlink = 0xa000000c // IO_REPARSE_TAG_SYMLINK
		tagLX      = 0xa000001d // IO_REPARSE_TAG_LX_SYMLINK (WSL)
		tagAppExec = 0x8000001b // IO_REPARSE_TAG_APPEXECLINK, not a name surrogate
		tagDedup   = 0x80000013
	)
	cases := []struct {
		name        string
		attrs, tag  uint32
		kind        uint8
		rule        sizeRule
		listedAgain bool
	}{
		{"file", archive, 0, 0, sizeClusters, false},
		{"hidden file", archive | hidden, 0, 0, sizeClusters, false},
		{"folder", attrDirectory, 0, kindFolder, sizeNone, true},
		{"junction", attrDirectory | attrReparsePoint, tagJunct, kindFolder | kindLink, sizeNone, false},
		{"folder symlink", attrDirectory | attrReparsePoint, tagSymlink, kindFolder | kindLink, sizeNone, false},
		{"file symlink", archive | attrReparsePoint, tagSymlink, kindLink, sizeNone, false},
		{"WSL symlink", attrReparsePoint, tagLX, kindLink, sizeNone, false},
		{"app execution alias", archive | attrReparsePoint, tagAppExec, 0, sizeClusters, false},
		{"online-only file", archive | attrReparsePoint | attrRecallOnDataAccess | unpinned, tagCloud6, kindCloud, sizeNone, false},
		{"offline file", archive | attrOffline, 0, kindCloud, sizeNone, false},
		{"recall-on-open file", attrRecallOnOpen, 0, kindCloud, sizeNone, false},
		{"locally available cloud file", archive | attrReparsePoint | pinned, tagCloud6, 0, sizeClusters, false},
		{"cloud folder placeholder", attrDirectory | attrReparsePoint | attrRecallOnOpen, tagCloud, kindFolder | kindCloud, sizeNone, true},
		{"synced cloud folder", attrDirectory | attrReparsePoint, tagCloud, kindFolder, sizeNone, true},
		{"compressed file", archive | attrCompressed, 0, 0, sizeCompressed, false},
		{"sparse file", archive | attrSparseFile, 0, 0, sizeCompressed, false},
		{"deduplicated file", archive | attrSparseFile | attrReparsePoint, tagDedup, 0, sizeCompressed, false},
		{"WOF-compressed file", archive | attrReparsePoint, reparseTagWOF, 0, sizeCompressed, false},
		{"compressed online-only file", attrCompressed | attrRecallOnDataAccess, 0, kindCloud, sizeNone, false},
		{"compressed folder", attrDirectory | attrCompressed, 0, kindFolder, sizeNone, true},
		// dwReserved0 is undefined without FILE_ATTRIBUTE_REPARSE_POINT.
		{"tag without reparse attribute", attrDirectory, tagJunct, kindFolder, sizeNone, true},
		{"WOF tag without reparse attribute", archive, reparseTagWOF, 0, sizeClusters, false},
	}
	for _, c := range cases {
		kind, rule := classify(c.attrs, c.tag)
		if kind != c.kind || rule != c.rule || descend(kind) != c.listedAgain {
			t.Errorf("%s: classify(%#x, %#x) = kind %d, rule %d, descend %t; want %d, %d, %t",
				c.name, c.attrs, c.tag, kind, rule, descend(kind), c.kind, c.rule, c.listedAgain)
		}
	}
}

func TestRoundUp(t *testing.T) {
	for _, c := range []struct{ size, cluster, want uint64 }{
		{0, 4096, 0}, {1, 4096, 4096}, {4096, 4096, 4096}, {4097, 4096, 8192},
		{10, 65536, 65536}, {10, 0, 10}, {10, 1, 10},
	} {
		if got := roundUp(c.size, c.cluster); got != c.want {
			t.Errorf("roundUp(%d, %d) = %d, want %d", c.size, c.cluster, got, c.want)
		}
	}
}

func TestFiletimeToMs(t *testing.T) {
	when := time.Date(2024, 2, 29, 12, 34, 56, 789_000_000, time.UTC)
	ft := uint64(when.UnixNano()/100) + filetimeUnixEpoch
	if got, want := filetimeToMs(ft), float64(when.UnixMilli()); got != want {
		t.Errorf("filetimeToMs = %v, want %v", got, want)
	}
	if got := filetimeToMs(filetimeUnixEpoch); got != 0 {
		t.Errorf("1970-01-01 = %v, want 0", got)
	}
	if got := filetimeToMs(0); got != 0 {
		t.Errorf("0 = %v, want 0 (unknown)", got)
	}
	if got := filetimeToMs(1 << 63); got != 0 {
		t.Errorf("out of range = %v, want 0", got)
	}
}

func TestAppendUTF16(t *testing.T) {
	for _, s := range []string{"", "a.txt", "Ä", "日本語", "😀 emoji", "mixed Ä😀x"} {
		if got := string(appendUTF16(nil, utf16.Encode([]rune(s)))); got != s {
			t.Errorf("appendUTF16(%q) = %q", s, got)
		}
	}
	// Unpaired surrogates, which Windows allows in names, become U+FFFD.
	for _, c := range []struct {
		in   []uint16
		want string
	}{
		{[]uint16{'a', 0xd800, 'b'}, "a�b"},
		{[]uint16{'a', 0xdc00}, "a�"},
		{[]uint16{0xd800}, "�"},
		{[]uint16{0xd83d, 0xd83d, 0xde00}, "�😀"},
	} {
		if got := string(appendUTF16([]byte("x"), c.in)); got != "x"+c.want {
			t.Errorf("appendUTF16(%x) = %q, want %q", c.in, got, "x"+c.want)
		}
	}
}
