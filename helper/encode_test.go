package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"strings"
	"testing"
	"unicode/utf8"
)

func le32(b []byte, v uint32) []byte { return binary.LittleEndian.AppendUint32(b, v) }

func f64s(b []byte, vs ...float64) []byte {
	for _, v := range vs {
		b = binary.LittleEndian.AppendUint64(b, math.Float64bits(v))
	}
	return b
}

func encode(t *testing.T, r *result) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := writeResult(&buf, r); err != nil {
		t.Fatal(err)
	}
	if int64(buf.Len()) != r.encodedLen() {
		t.Fatalf("encodedLen() = %d, but %d bytes were written", r.encodedLen(), buf.Len())
	}
	return buf.Bytes()
}

// sampleResult has UTF-8 names of 1 to 4 bytes per character, and names whose
// length needs padding after the names section.
func sampleResult(allocated bool) *result {
	r := &result{
		names:  []byte("C:\x00a.txt\x00Ä日😀\x00b\x00"),
		parent: []int32{-1, 0, 0, 2},
		kind:   []uint8{kindFolder, 0, kindFolder, kindCloud},
		size:   []float64{0, 10, 0, 5000},
		mtime:  []float64{1000, 2000, 3000, 1.7e12},
	}
	if allocated {
		r.alloc = []float64{0, 4096, 0, 0}
	}
	return r
}

func TestWriteResultLayoutAllocated(t *testing.T) {
	got := encode(t, sampleResult(true))

	var want []byte
	want = append(want, "DAH1"...)
	want = le32(want, 1)  // format version
	want = le32(want, 4)  // count
	want = le32(want, 1)  // flags: allocated section present
	want = le32(want, 20) // namesLength: "C:" 0 "a.txt" 0 "Ä日😀" (9 bytes) 0 "b"
	want = le32(want, 0)  // reserved
	want = append(want, "C:\x00a.txt\x00Ä日😀\x00b"...)
	// 24 + 20 = 44: four zero bytes up to the parent section at 48.
	want = append(want, 0, 0, 0, 0)
	want = le32(want, 0xffffffff)
	want = le32(want, 0)
	want = le32(want, 0)
	want = le32(want, 2)
	// kind at 64, already aligned; it ends at 68, so 4 zero bytes up to 72.
	want = append(want, 1, 0, 1, 8)
	want = append(want, 0, 0, 0, 0)
	want = f64s(want, 0, 10, 0, 5000)           // size at 72
	want = f64s(want, 1000, 2000, 3000, 1.7e12) // mtime at 104
	want = f64s(want, 0, 4096, 0, 0)            // allocated at 136

	if len(want) != 168 {
		t.Fatalf("test bug: want has %d bytes", len(want))
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("encoded result differs\n got %x\nwant %x", got, want)
	}
}

func TestWriteResultLayoutWithoutAllocated(t *testing.T) {
	got := encode(t, sampleResult(false))
	if len(got) != 136 {
		t.Fatalf("length = %d, want 136 (no allocated section)", len(got))
	}
	if flags := binary.LittleEndian.Uint32(got[12:]); flags != 0 {
		t.Errorf("flags = %d, want 0", flags)
	}
	// Everything before the allocated section is the same as with it.
	with := encode(t, sampleResult(true))
	with[12] = 0 // the flags differ
	if !bytes.Equal(got, with[:136]) {
		t.Errorf("sections differ from the allocated variant")
	}
}

func TestWriteResultNoPaddingNeeded(t *testing.T) {
	// A root name of 8 bytes ends the names section at 32, a multiple of 8,
	// so the parent section follows without padding.
	r := &result{
		names:  []byte("C:\\Users\x00"),
		parent: []int32{-1},
		kind:   []uint8{kindFolder | kindUnreadable},
		size:   []float64{0},
		mtime:  []float64{0},
		alloc:  []float64{0},
	}
	got := encode(t, r)
	var want []byte
	want = append(want, "DAH1"...)
	want = le32(want, 1)
	want = le32(want, 1)
	want = le32(want, 1)
	want = le32(want, 8)
	want = le32(want, 0)
	want = append(want, `C:\Users`...)
	want = le32(want, 0xffffffff)            // parent at 32, no padding before it
	want = append(want, 0, 0, 0, 0)          // up to 40
	want = append(want, 3)                   // kind at 40
	want = append(want, 0, 0, 0, 0, 0, 0, 0) // up to 48
	want = f64s(want, 0)                     // size at 48
	want = f64s(want, 0)                     // mtime at 56
	want = f64s(want, 0)                     // allocated at 64
	if len(want) != 72 {
		t.Fatalf("test bug: want has %d bytes", len(want))
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("encoded result differs\n got %x\nwant %x", got, want)
	}
}

func TestWriteResultAlignment(t *testing.T) {
	// Every combination of name length and count keeps every section on a
	// multiple of 8 with zero padding; decodeResult checks it.
	for namesLen := 1; namesLen <= 9; namesLen++ {
		for count := 1; count <= 9; count++ {
			r := &result{}
			for i := range count {
				name := "r"
				if i == 0 {
					name = strings.Repeat("x", namesLen)
				}
				r.names = append(append(r.names, name...), 0)
				r.parent = append(r.parent, int32(i-1))
				r.kind = append(r.kind, kindFolder)
				r.size = append(r.size, 0)
				r.mtime = append(r.mtime, float64(i))
				r.alloc = append(r.alloc, 0)
			}
			d := decodeResult(t, encode(t, r))
			if d.count != count || d.names[0] != strings.Repeat("x", namesLen) {
				t.Fatalf("namesLen %d, count %d: decoded %d entries, root %q", namesLen, count, d.count, d.names[0])
			}
		}
	}
}

// decoded is a result read back by decodeResult.
type decoded struct {
	count     int
	allocated bool
	names     []string
	parent    []int32
	kind      []uint8
	size      []float64
	mtime     []float64
	alloc     []float64
}

// decodeResult reads the binary format independently of the encoder, checks
// its layout rules (magic, version, alignment, zero padding, no trailing
// bytes) and the tree rules (parent[i] < i, folders without size).
func decodeResult(t *testing.T, data []byte) decoded {
	t.Helper()
	le := binary.LittleEndian
	if len(data) < 24 || string(data[:4]) != "DAH1" {
		t.Fatalf("not a result: % x", data[:min(len(data), 24)])
	}
	if v := le.Uint32(data[4:]); v != 1 {
		t.Fatalf("version = %d", v)
	}
	d := decoded{count: int(le.Uint32(data[8:]))}
	flags := le.Uint32(data[12:])
	if flags&^1 != 0 {
		t.Fatalf("unknown flags %#x", flags)
	}
	d.allocated = flags&1 != 0
	namesLen := int(le.Uint32(data[16:]))
	if r := le.Uint32(data[20:]); r != 0 {
		t.Fatalf("reserved = %d", r)
	}
	off := 24
	need := func(n int) []byte {
		t.Helper()
		if off+n > len(data) {
			t.Fatalf("result too short: need %d bytes at %d, have %d", n, off, len(data))
		}
		b := data[off : off+n]
		off += n
		return b
	}
	pad := func() {
		t.Helper()
		for off%8 != 0 {
			if b := need(1); b[0] != 0 {
				t.Fatalf("padding byte at %d is %d", off-1, b[0])
			}
		}
	}
	names := need(namesLen)
	if !utf8.Valid(names) {
		t.Fatalf("names are not valid UTF-8")
	}
	d.names = strings.Split(string(names), "\x00")
	if len(d.names) != d.count {
		t.Fatalf("%d names for %d entries", len(d.names), d.count)
	}
	pad()
	parentBytes := need(4 * d.count)
	d.parent = make([]int32, d.count)
	for i := range d.parent {
		d.parent[i] = int32(le.Uint32(parentBytes[4*i:]))
	}
	pad()
	d.kind = append([]uint8(nil), need(d.count)...)
	pad()
	readF64 := func() []float64 {
		t.Helper()
		if off%8 != 0 {
			t.Fatalf("f64 section at %d", off)
		}
		b := need(8 * d.count)
		vs := make([]float64, d.count)
		for i := range vs {
			vs[i] = math.Float64frombits(le.Uint64(b[8*i:]))
		}
		return vs
	}
	d.size = readF64()
	d.mtime = readF64()
	if d.allocated {
		d.alloc = readF64()
	}
	if off != len(data) {
		t.Fatalf("%d trailing bytes", len(data)-off)
	}

	if d.count < 1 || d.parent[0] != -1 {
		t.Fatalf("entry 0 is not a root: parent %v", d.parent[:min(d.count, 1)])
	}
	for i := 1; i < d.count; i++ {
		p := d.parent[i]
		if p < 0 || int(p) >= i {
			t.Fatalf("parent[%d] = %d", i, p)
		}
		if d.kind[p]&kindFolder == 0 {
			t.Fatalf("parent of %d is not a folder", i)
		}
		if d.names[i] == "" || strings.ContainsAny(d.names[i], `\/`) {
			t.Fatalf("name %d is %q, not one path component", i, d.names[i])
		}
	}
	for i := range d.count {
		if d.kind[i]&(kindFolder|kindLink) != 0 && d.size[i] != 0 {
			t.Fatalf("folder or link %q has size %v", d.names[i], d.size[i])
		}
		if d.allocated && d.kind[i]&(kindFolder|kindLink|kindCloud) != 0 && d.alloc[i] != 0 {
			t.Fatalf("%q (kind %d) has a size on disk of %v", d.names[i], d.kind[i], d.alloc[i])
		}
	}
	return d
}

// relPath is the path of entry i below the root, joined with "/".
func (d decoded) relPath(i int) string {
	var parts []string
	for ; i > 0; i = int(d.parent[i]) {
		parts = append(parts, d.names[i])
	}
	for l, r := 0, len(parts)-1; l < r; l, r = l+1, r-1 {
		parts[l], parts[r] = parts[r], parts[l]
	}
	return strings.Join(parts, "/")
}

// byPath maps every entry's relPath to its index; the root is "".
func (d decoded) byPath(t *testing.T) map[string]int {
	t.Helper()
	m := make(map[string]int, d.count)
	for i := range d.count {
		p := d.relPath(i)
		if _, dup := m[p]; dup {
			t.Fatalf("%q is in the result twice", p)
		}
		m[p] = i
	}
	return m
}
