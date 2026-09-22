package dataplane

import (
	"golang.zx2c4.com/wireguard/conn"

	"github.com/sovereign/proxy/v4/pkg/dataplane/stealth"
)

type stealthBind struct {
	inner conn.Bind
	obf   *stealth.Obfuscator
	mgr   *stealth.TransportManager
}

func newStealthBind(inner conn.Bind, obf *stealth.Obfuscator, mgr *stealth.TransportManager) conn.Bind {
	return &stealthBind{
		inner: inner,
		obf:   obf,
		mgr:   mgr,
	}
}

func (b *stealthBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	innerFns, actualPort, err := b.inner.Open(port)
	if err != nil {
		return nil, 0, err
	}
	fns := make([]conn.ReceiveFunc, len(innerFns))
	for i, fn := range innerFns {
		innerFn := fn
		fns[i] = func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
			n, err := innerFn(packets, sizes, eps)
			if err != nil {
				return n, err
			}
			if b.obf == nil {
				return n, nil
			}
			for j := 0; j < n; j++ {
				if sizes[j] == 0 {
					continue
				}
				clean, isJunk := b.obf.Unwrap(packets[j][:sizes[j]])
				if isJunk {
					sizes[j] = 0
					continue
				}
				copy(packets[j], clean)
				sizes[j] = len(clean)
			}
			return n, nil
		}
	}
	return fns, actualPort, nil
}

func (b *stealthBind) Close() error {
	return b.inner.Close()
}

func (b *stealthBind) SetMark(mark uint32) error {
	return b.inner.SetMark(mark)
}

func (b *stealthBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	if b.obf == nil {
		return b.inner.Send(bufs, ep)
	}

	wrapped := make([][]byte, 0, len(bufs))
	for _, buf := range bufs {
		// If sending a handshake initiation packet (Type 1), emit junk packets first
		if len(buf) >= 4 && buf[0] == 1 && buf[1] == 0 && buf[2] == 0 && buf[3] == 0 {
			junk := b.obf.GenerateJunk()
			if len(junk) > 0 {
				_ = b.inner.Send(junk, ep)
			}
		}
		w := b.obf.Wrap(buf)
		wrapped = append(wrapped, w)
	}
	return b.inner.Send(wrapped, ep)
}

func (b *stealthBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	return b.inner.ParseEndpoint(s)
}

func (b *stealthBind) BatchSize() int {
	return b.inner.BatchSize()
}
