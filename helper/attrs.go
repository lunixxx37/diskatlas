package main

import "math"

// Windows file attributes (WIN32_FIND_DATAW.dwFileAttributes) and reparse
// tags. They are defined here instead of taken from x/sys/windows so the
// classification below builds and is tested on every system.
const (
	attrDirectory          = 0x00000010
	attrSparseFile         = 0x00000200
	attrReparsePoint       = 0x00000400
	attrCompressed         = 0x00000800
	attrOffline            = 0x00001000
	attrRecallOnOpen       = 0x00040000
	attrRecallOnDataAccess = 0x00400000

	// Bit 29 of a reparse tag marks a name surrogate: a symbolic link,
	// junction or mount point that names another file or folder.
	reparseNameSurrogate = 0x20000000
	// IO_REPARSE_TAG_WOF: a file compressed by the Windows Overlay Filter
	// (CompactOS, "compact /exe"). It is compressed without carrying
	// FILE_ATTRIBUTE_COMPRESSED.
	reparseTagWOF = 0x80000017
)

// The kind bits of the binary result format.
const (
	kindFolder     uint8 = 1
	kindUnreadable uint8 = 2
	kindLink       uint8 = 4
	kindCloud      uint8 = 8
)

// sizeRule says how an entry's size on disk is worked out.
type sizeRule uint8

const (
	sizeNone       sizeRule = iota // 0: folders, links and cloud placeholders
	sizeClusters                   // the logical size rounded up to the cluster size
	sizeCompressed                 // ask the file system (GetCompressedFileSizeW)
)

// classify turns a listed entry's attributes and reparse tag into its kind
// bits and its size rule. The tag only counts when the attributes contain
// FILE_ATTRIBUTE_REPARSE_POINT, because dwReserved0 is undefined otherwise.
//
//   - Name surrogates get the link bit; they are listed but not followed.
//   - Offline and recall-on-open/-on-data-access entries are cloud
//     placeholders: their size on disk is 0 and they are never opened.
//   - Compressed and sparse files (and WOF-compressed ones) ask the file
//     system for their size on disk; all other files round up to clusters.
func classify(attrs, tag uint32) (uint8, sizeRule) {
	if attrs&attrReparsePoint == 0 {
		tag = 0
	}
	var kind uint8
	if attrs&attrDirectory != 0 {
		kind |= kindFolder
	}
	if tag&reparseNameSurrogate != 0 {
		kind |= kindLink
	}
	if attrs&(attrOffline|attrRecallOnOpen|attrRecallOnDataAccess) != 0 {
		kind |= kindCloud
	}
	switch {
	case kind != 0:
		return kind, sizeNone
	case attrs&(attrCompressed|attrSparseFile) != 0 || tag == reparseTagWOF:
		return kind, sizeCompressed
	default:
		return kind, sizeClusters
	}
}

// descend reports whether an entry with these kind bits is a folder that is
// listed in turn. Links are not followed; cloud folders are listed like
// normal ones (listing them never downloads file contents).
func descend(kind uint8) bool {
	return kind&kindFolder != 0 && kind&kindLink == 0
}

// roundUp rounds size up to a multiple of cluster.
func roundUp(size, cluster uint64) uint64 {
	if cluster <= 1 || size == 0 {
		return size
	}
	return (size + cluster - 1) / cluster * cluster
}

// filetimeUnixEpoch is 1970-01-01 UTC as a FILETIME: 100 ns intervals since
// 1601-01-01 UTC.
const filetimeUnixEpoch = 116444736000000000

// filetimeToMs converts a FILETIME to milliseconds since 1970-01-01 UTC, or
// to 0 ("unknown") when it is 0 or out of range.
func filetimeToMs(ft uint64) float64 {
	if ft == 0 || ft > math.MaxInt64 {
		return 0
	}
	return float64((int64(ft) - filetimeUnixEpoch) / 10000)
}
