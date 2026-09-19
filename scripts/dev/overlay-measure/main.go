// Command overlay-measure measures a node's overlay path through its own SOCKS5
// proxy, against the WP-201 spike responder on another node.
//
// It goes through SOCKS5 rather than opening its own tunnel on purpose: that is the
// path a real client takes, and measuring anything else would be measuring a path
// the product does not have.
//
// Every number it prints is measured. When a measurement does not complete it says
// so and exits non-zero; it never falls back to a plausible figure.
package main

import (
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"time"
)

// The spike responder's mode bytes. Kept in sync with pkg/dataplane by hand: this
// command is a measurement tool and importing the package would pull the whole
// WireGuard stack into it for three constants.
const (
	modeEcho   = 'E'
	modeDrain  = 'D'
	modeSource = 'S'
)

func main() {
	socksAddr := flag.String("socks", "127.0.0.1:1080", "SOCKS5 proxy of the local node")
	target := flag.String("target", "", "Overlay address:port of the spike responder")
	samples := flag.Int("rtt-samples", 50, "Number of round trips to time")
	duration := flag.Duration("duration", 30*time.Second, "Duration of each throughput direction")
	marker := flag.String("marker", "", "A string to send through the overlay and read back, for a capture to be searched for")
	flag.Parse()

	if *target == "" {
		fmt.Fprintln(os.Stderr, "overlay-measure: -target is required")
		os.Exit(2)
	}

	fmt.Printf("target %s via socks5 %s\n", *target, *socksAddr)

	if *marker != "" {
		if err := sendMarker(*socksAddr, *target, *marker); err != nil {
			fmt.Fprintf(os.Stderr, "overlay-measure: marker: %v\n", err)
			os.Exit(1)
		}
	}
	if err := measureRTT(*socksAddr, *target, *samples); err != nil {
		fmt.Fprintf(os.Stderr, "overlay-measure: round trip: %v\n", err)
		os.Exit(1)
	}
	// A zero duration runs the marker and latency phases only, which is what a run
	// under a packet capture wants: a throughput flood makes the capture lossy and
	// a lossy capture cannot show that something is absent from the wire.
	if *duration <= 0 {
		return
	}

	if err := measureSend(*socksAddr, *target, *duration); err != nil {
		fmt.Fprintf(os.Stderr, "overlay-measure: send throughput: %v\n", err)
		os.Exit(1)
	}
	if err := measureReceive(*socksAddr, *target, *duration); err != nil {
		fmt.Fprintf(os.Stderr, "overlay-measure: receive throughput: %v\n", err)
		os.Exit(1)
	}
}

// sendMarker pushes a known string through the overlay and reads it back. A
// capture taken on the container network is then searched for it: if the payload
// were on the wire in clear, this is the string that would be found.
func sendMarker(socksAddr, target, marker string) error {
	conn, err := dialThroughSOCKS5(socksAddr, target)
	if err != nil {
		return err
	}
	defer conn.Close()

	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return err
	}
	if _, err := conn.Write(append([]byte{modeEcho}, marker...)); err != nil {
		return err
	}

	got := make([]byte, len(marker))
	if _, err := io.ReadFull(conn, got); err != nil {
		return err
	}
	if string(got) != marker {
		return fmt.Errorf("the overlay returned %q, not the marker", got)
	}

	fmt.Printf("marker echoed through the overlay: %s (%d bytes each way)\n", marker, len(marker))
	return nil
}

func measureRTT(socksAddr, target string, samples int) error {
	conn, err := dialThroughSOCKS5(socksAddr, target)
	if err != nil {
		return err
	}
	defer conn.Close()

	if _, err := conn.Write([]byte{modeEcho}); err != nil {
		return err
	}

	// One byte out, one byte back, on an already established connection: this is
	// the application level round trip, not an ICMP one.
	out := []byte{0x42}
	in := make([]byte, 1)
	timings := make([]time.Duration, 0, samples)

	for i := 0; i < samples; i++ {
		if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		start := time.Now()
		if _, err := conn.Write(out); err != nil {
			return err
		}
		if _, err := io.ReadFull(conn, in); err != nil {
			return err
		}
		timings = append(timings, time.Since(start))
	}

	sort.Slice(timings, func(i, j int) bool { return timings[i] < timings[j] })
	var total time.Duration
	for _, d := range timings {
		total += d
	}

	fmt.Printf("tcp round trip over overlay: samples %d min %.3f ms median %.3f ms p95 %.3f ms max %.3f ms mean %.3f ms\n",
		len(timings),
		ms(timings[0]),
		ms(timings[len(timings)/2]),
		ms(timings[(len(timings)*95)/100]),
		ms(timings[len(timings)-1]),
		ms(total/time.Duration(len(timings))),
	)
	return nil
}

// measureSend streams to the responder for the requested time and reports what the
// responder counted, not what this process handed to a socket.
func measureSend(socksAddr, target string, d time.Duration) error {
	conn, err := dialThroughSOCKS5(socksAddr, target)
	if err != nil {
		return err
	}
	defer conn.Close()

	request := make([]byte, 9)
	request[0] = modeDrain
	binary.BigEndian.PutUint64(request[1:], uint64(d.Milliseconds()))
	if _, err := conn.Write(request); err != nil {
		return err
	}

	block := make([]byte, 64*1024)
	for i := range block {
		block[i] = byte(i*31 + 7)
	}

	if err := conn.SetDeadline(time.Now().Add(d + 60*time.Second)); err != nil {
		return err
	}

	stop := make(chan struct{})
	writeErr := make(chan error, 1)
	go func() {
		for {
			select {
			case <-stop:
				writeErr <- nil
				return
			default:
			}
			if _, err := conn.Write(block); err != nil {
				writeErr <- err
				return
			}
		}
	}()

	var report [16]byte
	_, readErr := io.ReadFull(conn, report[:])
	close(stop)
	<-writeErr

	if readErr != nil {
		return fmt.Errorf("reading the responder's report: %w", readErr)
	}

	received := binary.BigEndian.Uint64(report[0:8])
	elapsed := time.Duration(binary.BigEndian.Uint64(report[8:16]))
	if received == 0 || elapsed <= 0 {
		return errors.New("the responder reported no traffic")
	}

	fmt.Printf("send throughput (counted by the receiver): %s in %.1f s = %.2f Mbit/s\n",
		bytesHuman(received), elapsed.Seconds(), mbits(received, elapsed))
	return nil
}

func measureReceive(socksAddr, target string, d time.Duration) error {
	conn, err := dialThroughSOCKS5(socksAddr, target)
	if err != nil {
		return err
	}
	defer conn.Close()

	if _, err := conn.Write([]byte{modeSource}); err != nil {
		return err
	}

	buf := make([]byte, 64*1024)
	deadline := time.Now().Add(d)
	if err := conn.SetDeadline(deadline.Add(30 * time.Second)); err != nil {
		return err
	}

	var got uint64
	start := time.Now()
	for time.Now().Before(deadline) {
		n, err := conn.Read(buf)
		got += uint64(n)
		if err != nil {
			return err
		}
	}
	elapsed := time.Since(start)

	fmt.Printf("receive throughput: %s in %.1f s = %.2f Mbit/s\n",
		bytesHuman(got), elapsed.Seconds(), mbits(got, elapsed))
	return nil
}

// dialThroughSOCKS5 performs an RFC 1928 CONNECT to target.
func dialThroughSOCKS5(socksAddr, target string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return nil, fmt.Errorf("target %q: %w", target, err)
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return nil, fmt.Errorf("target port %q: %w", portStr, err)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, fmt.Errorf("target host %q is not an IP address", host)
	}

	conn, err := net.DialTimeout("tcp", socksAddr, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connecting to the SOCKS5 proxy: %w", err)
	}

	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		conn.Close()
		return nil, err
	}

	// Greeting: version 5, one method, no authentication.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		conn.Close()
		return nil, err
	}
	var method [2]byte
	if _, err := io.ReadFull(conn, method[:]); err != nil {
		conn.Close()
		return nil, err
	}
	if method[0] != 0x05 || method[1] != 0x00 {
		conn.Close()
		return nil, fmt.Errorf("SOCKS5 proxy chose version %#x method %#x", method[0], method[1])
	}

	req := []byte{0x05, 0x01, 0x00}
	if v4 := ip.To4(); v4 != nil {
		req = append(req, 0x01)
		req = append(req, v4...)
	} else {
		req = append(req, 0x04)
		req = append(req, ip.To16()...)
	}
	req = append(req, byte(port>>8), byte(port))
	if _, err := conn.Write(req); err != nil {
		conn.Close()
		return nil, err
	}

	var reply [4]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		conn.Close()
		return nil, err
	}
	if reply[1] != 0x00 {
		conn.Close()
		return nil, fmt.Errorf("SOCKS5 CONNECT to %s refused with reply code %#x", target, reply[1])
	}

	// Skip the bound address the proxy reports.
	var skip int
	switch reply[3] {
	case 0x01:
		skip = 4
	case 0x04:
		skip = 16
	case 0x03:
		var l [1]byte
		if _, err := io.ReadFull(conn, l[:]); err != nil {
			conn.Close()
			return nil, err
		}
		skip = int(l[0])
	default:
		conn.Close()
		return nil, fmt.Errorf("SOCKS5 reply carries unknown address type %#x", reply[3])
	}
	if _, err := io.CopyN(io.Discard, conn, int64(skip)+2); err != nil {
		conn.Close()
		return nil, err
	}

	if err := conn.SetDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func mbits(n uint64, d time.Duration) float64 {
	if d <= 0 {
		return 0
	}
	return float64(n) * 8 / d.Seconds() / 1e6
}

func bytesHuman(n uint64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2f GiB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.2f MiB", float64(n)/(1<<20))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
