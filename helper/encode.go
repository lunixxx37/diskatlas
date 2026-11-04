package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"slices"
)

// The binary result format (docs/helper-protocol.md, "Binary result format").
// Little-endian; every section starts at a multiple of 8.
const (
	resultMagic     = "DAH1"
	resultVersion   = 1
	resultHeaderLen = 24
	flagAllocated   = 1
)

// result is a scan's entries as columns, in the order the format stores them.
// Entry 0 is the root, and every entry's parent comes before it.
type result struct {
	names  []byte    // UTF-8; every name is followed by a \0
	parent []int32   // -1 for the root
	kind   []uint8   // kind bits
	size   []float64 // logical size in bytes; 0 for folders
	mtime  []float64 // ms since 1970-01-01 UTC; 0 if unknown
	alloc  []float64 // size on disk; nil when it wasn't asked for
}

func (r *result) count() int { return len(r.parent) }

// namesLen is the length of the names section: the names joined with \0,
// without a trailing \0.
func (r *result) namesLen() int { return max(len(r.names)-1, 0) }

// layout holds the section offsets of an encoded result.
type layout struct {
	parent, kind, size, mtime, alloc, total int64
}

func pad8(n int64) int64 { return (n + 7) &^ 7 }

func newLayout(count, namesLen int, allocated bool) layout {
	n := int64(count)
	var l layout
	l.parent = pad8(resultHeaderLen + int64(namesLen))
	l.kind = pad8(l.parent + 4*n)
	l.size = pad8(l.kind + n)
	l.mtime = l.size + 8*n
	l.total = l.mtime + 8*n
	if allocated {
		l.alloc = l.total
		l.total += 8 * n
	}
	return l
}

// encodedLen is the byte length of r in the binary format.
func (r *result) encodedLen() int64 {
	return newLayout(r.count(), r.namesLen(), r.alloc != nil).total
}

// writeResult writes r in the binary result format. It streams the columns
// in chunks, so a large result isn't copied into one more buffer.
func writeResult(w io.Writer, r *result) error {
	n := r.count()
	names := r.names[:r.namesLen()]
	allocated := r.alloc != nil
	l := newLayout(n, len(names), allocated)

	bw := bufio.NewWriterSize(w, 64<<10)
	var header [resultHeaderLen]byte
	copy(header[0:4], resultMagic)
	binary.LittleEndian.PutUint32(header[4:], resultVersion)
	binary.LittleEndian.PutUint32(header[8:], uint32(n))
	var flags uint32
	if allocated {
		flags |= flagAllocated
	}
	binary.LittleEndian.PutUint32(header[12:], flags)
	binary.LittleEndian.PutUint32(header[16:], uint32(len(names)))
	// header[20:24] is reserved and stays 0.
	bw.Write(header[:])
	bw.Write(names)
	writeZeros(bw, l.parent-(resultHeaderLen+int64(len(names))))

	buf := make([]byte, 0, 64<<10)
	buf = writeColumn(bw, buf, r.parent)
	writeZeros(bw, l.kind-(l.parent+4*int64(n)))
	bw.Write(r.kind)
	writeZeros(bw, l.size-(l.kind+int64(n)))
	buf = writeColumn(bw, buf, r.size)
	buf = writeColumn(bw, buf, r.mtime)
	if allocated {
		writeColumn(bw, buf, r.alloc)
	}
	// bufio.Writer keeps the first write error and returns it here.
	return bw.Flush()
}

// writeColumn writes a column of numbers in little-endian order, reusing buf.
func writeColumn[T int32 | float64](bw *bufio.Writer, buf []byte, col []T) []byte {
	for chunk := range slices.Chunk(col, 8<<10) {
		buf, _ = binary.Append(buf[:0], binary.LittleEndian, chunk)
		bw.Write(buf)
	}
	return buf
}

var zeros [8]byte

func writeZeros(bw *bufio.Writer, n int64) {
	bw.Write(zeros[:n])
}
