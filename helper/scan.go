package main

import (
	"context"
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// Scan states, as the API reports them.
const (
	stateRunning   = "running"
	stateDone      = "done"
	stateCancelled = "cancelled"
	stateFailed    = "failed"
)

// listFunc lists one folder into b. listDir is the platform's implementation;
// tests swap in their own.
type listFunc func(ctx context.Context, dir dirPath, opt listOptions, b *batch) error

type listOptions struct {
	allocated bool   // work out the size on disk
	cluster   uint64 // cluster size of the scanned volume
}

// rootInfo describes where a scan starts. openRoot fills it in per platform.
type rootInfo struct {
	dir     dirPath // the folder to list first
	name    string  // the root entry's name
	kind    uint8   // kindFolder, maybe with kindCloud
	mtime   float64
	cluster uint64
}

// batch collects one folder's entries, so they are added to the result in a
// single step under the scan's lock.
type batch struct {
	names   []byte // UTF-8, every name followed by \0
	kind    []uint8
	size    []float64
	mtime   []float64
	alloc   []float64
	subdirs []subdir // folders to list next

	files, dirs, errors, bytes uint64
}

// subdir is a folder found in a batch that is listed in turn.
type subdir struct {
	pos  int // position in the batch
	path dirPath
}

func (b *batch) reset() {
	b.names = b.names[:0]
	b.kind = b.kind[:0]
	b.size = b.size[:0]
	b.mtime = b.mtime[:0]
	b.alloc = b.alloc[:0]
	clear(b.subdirs) // drop the paths, they belong to the queue now
	b.subdirs = b.subdirs[:0]
	b.files, b.dirs, b.errors, b.bytes = 0, 0, 0, 0
}

// add records an entry whose name the caller has just appended to b.names
// (without its terminator), and returns its position in the batch.
func (b *batch) add(kind uint8, size uint64, mtime float64, alloc uint64) int {
	b.names = append(b.names, 0)
	pos := len(b.kind)
	b.kind = append(b.kind, kind)
	b.size = append(b.size, float64(size))
	b.mtime = append(b.mtime, mtime)
	b.alloc = append(b.alloc, float64(alloc))
	if kind&kindFolder != 0 {
		b.dirs++
	} else {
		b.files++
		b.bytes += size
	}
	if kind&kindUnreadable != 0 {
		b.errors++
	}
	return pos
}

// scan is one scan: its progress, its result and the workers that fill it.
type scan struct {
	id        string
	path      string // the cleaned path, as the API reports it
	allocated bool
	started   time.Time
	ctx       context.Context
	cancel    context.CancelFunc
	list      listFunc
	workers   int
	onEnd     func(*scan) // called once when the state leaves "running"

	// Progress counters, read without the lock.
	entries, files, dirs, bytes, errors atomic.Uint64
	current                             atomic.Pointer[dirPath]

	mu      sync.Mutex
	state   string
	failure string
	elapsed time.Duration // frozen when the scan ends
	res     result        // only changes while the state is "running"
}

// defaultWorkers is the number of folders read in parallel.
func defaultWorkers() int {
	return min(max(runtime.NumCPU(), 4), 16)
}

// newScan creates a scan whose result already holds the root entry, so even
// a scan cancelled before it started has a valid (one entry) result.
func newScan(id, path string, allocated bool, root rootInfo, list listFunc, workers int) *scan {
	ctx, cancel := context.WithCancel(context.Background())
	s := &scan{
		id:        id,
		path:      path,
		allocated: allocated,
		started:   time.Now(),
		ctx:       ctx,
		cancel:    cancel,
		list:      list,
		workers:   max(workers, 1),
		state:     stateRunning,
	}
	r := &s.res
	r.names = append(append(r.names, root.name...), 0)
	r.parent = append(r.parent, -1)
	r.kind = append(r.kind, root.kind)
	r.size = append(r.size, 0)
	r.mtime = append(r.mtime, root.mtime)
	if allocated {
		r.alloc = append(r.alloc, 0)
	}
	s.entries.Store(1)
	return s
}

// run lists the tree from root with a pool of workers and returns when the
// scan has ended.
func (s *scan) run(root rootInfo) {
	defer s.cancel()
	q := newWorkQueue(job{index: 0, path: root.dir})
	stop := context.AfterFunc(s.ctx, q.stop)
	defer stop()
	opt := listOptions{allocated: s.allocated, cluster: root.cluster}
	var wg sync.WaitGroup
	for range s.workers {
		wg.Go(func() { s.work(q, opt) })
	}
	wg.Wait()
	s.finish(stateDone, "")
}

func (s *scan) work(q *workQueue, opt listOptions) {
	defer func() {
		if v := recover(); v != nil {
			s.finish(stateFailed, fmt.Sprintf("internal error: %v", v))
			q.stop()
		}
	}()
	b := new(batch)
	for {
		j, ok := q.pop()
		if !ok {
			return
		}
		s.current.Store(&j.path)
		b.reset()
		err := s.list(s.ctx, j.path, opt, b)
		base, ok, failure := s.commit(j.index, b, err)
		if failure != "" {
			s.finish(stateFailed, failure)
		}
		q.done(base, b.subdirs, ok)
	}
}

// commit adds a listed folder's entries to the result in one step. Each
// entry gets its index here, after its parent's, so parent[i] < i holds. If
// listErr is set, the folder could not be (fully) listed and gets the
// unreadable bit. commit returns the first new index, or ok=false once the
// scan has ended: then the batch is dropped, so a result never changes after
// the state left "running".
func (s *scan) commit(parent int32, b *batch, listErr error) (base int32, ok bool, failure string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != stateRunning {
		return 0, false, ""
	}
	r := &s.res
	n := len(b.kind)
	if int64(len(r.parent))+int64(n) > math.MaxInt32 || int64(len(r.names))+int64(len(b.names)) > math.MaxUint32 {
		return 0, false, "the folder holds more entries than a result can describe"
	}
	base = int32(len(r.parent))
	r.names = append(r.names, b.names...)
	for range n {
		r.parent = append(r.parent, parent)
	}
	r.kind = append(r.kind, b.kind...)
	r.size = append(r.size, b.size...)
	r.mtime = append(r.mtime, b.mtime...)
	if r.alloc != nil {
		r.alloc = append(r.alloc, b.alloc...)
	}
	errs := b.errors
	if listErr != nil && r.kind[parent]&kindUnreadable == 0 {
		r.kind[parent] |= kindUnreadable
		errs++
	}
	s.entries.Add(uint64(n))
	s.files.Add(b.files)
	s.dirs.Add(b.dirs)
	s.bytes.Add(b.bytes)
	s.errors.Add(errs)
	return base, true, ""
}

// finish moves a running scan to its final state and stops the workers. It
// does nothing if the scan has already ended.
func (s *scan) finish(state, failure string) {
	s.mu.Lock()
	if s.state != stateRunning {
		s.mu.Unlock()
		return
	}
	s.state = state
	s.failure = failure
	s.elapsed = time.Since(s.started)
	s.mu.Unlock()
	s.cancel()
	s.current.Store(nil)
	if s.onEnd != nil {
		s.onEnd(s)
	}
}

func (s *scan) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state == stateRunning
}

// snapshot returns the result and the state. Once the state is no longer
// "running", the result doesn't change any more and may be read freely.
func (s *scan) snapshot() (*result, string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &s.res, s.state, s.failure
}

// progressJSON is the body of GET /v1/scans/{id}.
type progressJSON struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	Path        string `json:"path"`
	Entries     uint64 `json:"entries"`
	Files       uint64 `json:"files"`
	Dirs        uint64 `json:"dirs"`
	Bytes       uint64 `json:"bytes"`
	Errors      uint64 `json:"errors"`
	CurrentPath string `json:"currentPath"`
	ElapsedMs   int64  `json:"elapsedMs"`
	Error       string `json:"error"`
}

func (s *scan) progress() progressJSON {
	s.mu.Lock()
	state, failure, elapsed := s.state, s.failure, s.elapsed
	s.mu.Unlock()
	p := progressJSON{
		ID:      s.id,
		State:   state,
		Path:    s.path,
		Entries: s.entries.Load(),
		Files:   s.files.Load(),
		Dirs:    s.dirs.Load(),
		Bytes:   s.bytes.Load(),
		Errors:  s.errors.Load(),
		Error:   failure,
	}
	if state == stateRunning {
		elapsed = time.Since(s.started)
		if c := s.current.Load(); c != nil {
			p.CurrentPath = displayPath(*c)
		}
	}
	p.ElapsedMs = elapsed.Milliseconds()
	return p
}

// job is a folder waiting to be listed: its entry index and its path.
type job struct {
	index int32
	path  dirPath
}

// workQueue hands folders to the workers. It is a stack, so the scan goes
// depth first and few folders wait at a time. It ends by itself when no
// folder is left and no worker is busy, or when stop is called.
type workQueue struct {
	mu      sync.Mutex
	cond    sync.Cond
	jobs    []job
	busy    int // workers that hold a job
	waiting int // workers waiting for one
	stopped bool
}

func newWorkQueue(first job) *workQueue {
	q := &workQueue{jobs: []job{first}}
	q.cond.L = &q.mu
	return q
}

// pop returns the next folder to list, or false when the scan is over.
func (q *workQueue) pop() (job, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for !q.stopped && len(q.jobs) == 0 {
		q.waiting++
		q.cond.Wait()
		q.waiting--
	}
	if q.stopped {
		return job{}, false
	}
	last := len(q.jobs) - 1
	j := q.jobs[last]
	q.jobs[last] = job{}
	q.jobs = q.jobs[:last]
	q.busy++
	return j, true
}

// done ends a worker's job and queues the folders it found, whose entries
// start at index base. ok=false drops them.
func (q *workQueue) done(base int32, subdirs []subdir, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.busy--
	pushed := 0
	if ok && !q.stopped {
		for _, d := range subdirs {
			q.jobs = append(q.jobs, job{index: base + int32(d.pos), path: d.path})
		}
		pushed = len(subdirs)
	}
	switch {
	case len(q.jobs) == 0 && q.busy == 0:
		q.stopped = true
		q.cond.Broadcast()
	case pushed >= q.waiting:
		q.cond.Broadcast()
	default:
		for range pushed {
			q.cond.Signal()
		}
	}
}

func (q *workQueue) stop() {
	q.mu.Lock()
	q.stopped = true
	q.mu.Unlock()
	q.cond.Broadcast()
}
