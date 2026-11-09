//go:build !windows
// +build !windows

package main

import (
	"fmt"
	"os"
)

// On other platforms the binary only exists so the platform-independent code can be built
// and tested; the tunnel and the service are Windows-only.
func main() {
	fmt.Fprintln(os.Stderr, "neronet-windows runs only on Windows")
	os.Exit(1)
}
