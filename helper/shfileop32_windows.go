//go:build !(amd64 || arm64)

package main

import "encoding/binary"

// shFileOpStruct is SHFILEOPSTRUCTW. On 32-bit Windows shellapi.h packs it
// to 1 byte, so the BOOL after the 2-byte flags sits at offset 18, not 20:
// the fields from there on are byte arrays to keep Go from aligning them.
type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted [4]byte
	hNameMappings         [4]byte
	lpszProgressTitle     [4]byte
}

func (op *shFileOpStruct) aborted() bool {
	return binary.LittleEndian.Uint32(op.fAnyOperationsAborted[:]) != 0
}
