package control

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNativeTelemetrySessionChangeRequestsRegistration(t *testing.T) {
	for _, code := range []string{"native_telemetry_session_changed", "counter_conflict"} {
		t.Run(code, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusConflict)
				_, _ = fmt.Fprintf(w, `{"error":"observation conflict","code":%q}`, code)
			}))
			defer server.Close()
			_, err := NewClient(server.URL).SendHeartbeat(t.Context(), "a", nil, 0, 0, 0, 0, false)
			if errors.Is(err, ErrUnauthorized) != (code == "native_telemetry_session_changed") {
				t.Fatalf("session reset must reach the daemon's re-registration path, other conflicts must remain errors: %v", err)
			}
		})
	}
}
