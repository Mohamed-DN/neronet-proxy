//go:build !darwin

package main

import (
	"errors"
	"io"
)

// runUp needs utun, which exists only on macOS. The other platforms build the package so the
// pure parts can be tested on Linux.
func runUp(profilePath string, stdout io.Writer) error {
	return errors.New("neronet up runs only on macOS")
}
