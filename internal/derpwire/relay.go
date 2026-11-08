package derpwire

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sync"

	"go4.org/mem"
	"tailscale.com/derp/derpserver"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// RelayServer authenticates the upstream encrypted private-key proof, then asks
// NeroNet's admission cache whether that identity is currently permitted.
type RelayServer struct {
	mu        sync.RWMutex
	private   key.NodePrivate
	logf      logger.Logf
	admit     func([32]byte) bool
	server    *derpserver.Server
	admission *http.Server
	listener  net.Listener
	closed    bool
}

func NewRelay(private [32]byte, admit func([32]byte) bool, logf func(string, ...any)) (*RelayServer, error) {
	if private == ([32]byte{}) || admit == nil {
		return nil, errors.New("DERP: private key and admission cache are required")
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	r := &RelayServer{private: key.NodePrivateFromRaw32(mem.B(private[:])), admit: admit, logf: logf, listener: ln}
	r.admission = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var q tailcfg.DERPAdmitClientRequest
		if json.NewDecoder(http.MaxBytesReader(w, request.Body, 4096)).Decode(&q) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(tailcfg.DERPAdmitClientResponse{Allow: r.admit(q.NodePublic.Raw32())})
	})}
	r.server = r.newServer()
	go func() { _ = r.admission.Serve(ln) }()
	return r, nil
}

func (r *RelayServer) newServer() *derpserver.Server {
	s := derpserver.New(r.private, r.logf)
	s.SetVerifyClientURL("http://" + r.listener.Addr().String() + "/")
	s.SetVerifyClientURLFailOpen(false)
	return s
}

func (r *RelayServer) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if request.TLS == nil {
		http.Error(w, "HTTPS required", http.StatusUpgradeRequired)
		return
	}
	r.mu.RLock()
	s, closed := r.server, r.closed
	r.mu.RUnlock()
	if closed {
		http.Error(w, "relay closed", http.StatusServiceUnavailable)
		return
	}
	derpserver.Handler(s).ServeHTTP(w, request)
}

// Invalidate disconnects existing sessions as well as denying new ones. Upstream
// admission only checks at connect time; rotating the server closes all sessions
// without granting a mesh administration credential. Remaining nodes reconnect.
func (r *RelayServer) Invalidate() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	old := r.server
	r.server = r.newServer()
	r.mu.Unlock()
	_ = old.Close()
}

func (r *RelayServer) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	s := r.server
	r.mu.Unlock()
	_ = s.Close()
	return r.admission.Shutdown(context.Background())
}
