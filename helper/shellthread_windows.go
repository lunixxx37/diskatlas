//go:build windows

package main

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	moduser32                       = windows.NewLazySystemDLL("user32.dll")
	procMsgWaitForMultipleObjectsEx = moduser32.NewProc("MsgWaitForMultipleObjectsEx")
	procPeekMessageW                = moduser32.NewProc("PeekMessageW")
	procTranslateMessage            = moduser32.NewProc("TranslateMessage")
	procDispatchMessageW            = moduser32.NewProc("DispatchMessageW")
)

const (
	qsAllInput         = 0x04ff
	mwmoInputAvailable = 0x0004
	pmRemove           = 0x0001
)

// winMsg is MSG.
type winMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
	private uint32
}

// shellThread runs shell calls (SHFileOperationW, SHOpenFolderAndSelectItems)
// one after the other on a single OS thread that has COM in a
// single-threaded apartment, as the shell requires. Between calls the thread
// waits for work while dispatching window messages, as an STA thread should,
// so windows COM or the shell create on it never stop answering.
type shellThread struct {
	once  sync.Once
	err   error
	jobs  chan func()
	ready windows.Handle // auto-reset event: a job is waiting
	tid   atomic.Uint32  // the OS thread's id, once it runs
}

// isCurrent reports whether the caller runs on the shell thread.
func (t *shellThread) isCurrent() bool {
	id := t.tid.Load()
	return id != 0 && id == windows.GetCurrentThreadId()
}

var theShell shellThread

// run runs f on the shell thread and returns its result.
func (t *shellThread) run(f func() error) error {
	t.once.Do(t.start)
	if t.err != nil {
		return t.err
	}
	done := make(chan error, 1)
	t.jobs <- func() { done <- callSafely(f) }
	windows.SetEvent(t.ready)
	return <-done
}

func (t *shellThread) start() {
	t.ready, t.err = windows.CreateEvent(nil, 0, 0, nil)
	if t.err != nil {
		return
	}
	t.jobs = make(chan func(), 16)
	started := make(chan error)
	go t.loop(started)
	t.err = <-started
}

func (t *shellThread) loop(started chan<- error) {
	// Never unlocked: the thread belongs to the shell for the helper's life.
	runtime.LockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE); err != nil && err != syscall.Errno(1) {
		started <- fmt.Errorf("could not initialize COM: %w", err)
		return
	}
	t.tid.Store(windows.GetCurrentThreadId())
	close(started)
	var m winMsg
	for {
	jobs:
		for {
			select {
			case job := <-t.jobs:
				job()
			default:
				break jobs
			}
		}
		for {
			r, _, _ := syscall.SyscallN(procPeekMessageW.Addr(), uintptr(unsafe.Pointer(&m)), 0, 0, 0, pmRemove)
			if r == 0 {
				break
			}
			syscall.SyscallN(procTranslateMessage.Addr(), uintptr(unsafe.Pointer(&m)))
			syscall.SyscallN(procDispatchMessageW.Addr(), uintptr(unsafe.Pointer(&m)))
		}
		// Sleep until a job or a window message arrives.
		syscall.SyscallN(procMsgWaitForMultipleObjectsEx.Addr(), 1, uintptr(unsafe.Pointer(&t.ready)),
			uintptr(windows.INFINITE), qsAllInput, mwmoInputAvailable)
	}
}

// callSafely turns a panic in a shell call into an error, so the thread
// keeps serving.
func callSafely(f func() error) (err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("internal error: %v", v)
		}
	}()
	return f()
}
