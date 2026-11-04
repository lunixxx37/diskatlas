//go:build amd64 || arm64

package main

// shFileOpStruct is SHFILEOPSTRUCTW. On 64-bit Windows shellapi.h packs it to
// 8 bytes, which is Go's natural layout.
type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

func (op *shFileOpStruct) aborted() bool { return op.fAnyOperationsAborted != 0 }
