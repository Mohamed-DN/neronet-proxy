package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/sovereign/proxy/v4/pkg/config"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/nat"
)

func printHelp() {
	fmt.Print(`NeroNet v4.0 (DarkNero Mesh) — Operator & Diagnostic CLI

Usage:
  sovereign-cli <command> [arguments]

Commands:
  status                Display control plane status, topology epoch, and active relays
  peers <country>       List available exit bridges matching ISO country code
  circuit <country>     Build and inspect a 3-Hop Layered Onion Circuit
  keygen                Generate a fresh Curve25519 identity keypair and Node ID
  stun-ping <host:port> Ping a STUN endpoint and measure NAT reflection latency
  help                  Show this help message

Global Options:
  --control-url <url>   Control plane API address (default: http://127.0.0.1:8443 or $SOVEREIGN_CONTROL_PLANE_URL)
`)
}

func main() {
	_ = config.LoadDotEnv()

	if len(os.Args) < 2 {
		printHelp()
		os.Exit(1)
	}

	controlURL := config.GetEnv("SOVEREIGN_CONTROL_PLANE_URL", "http://127.0.0.1:8443")
	cmdArgs := []string{}
	for i := 1; i < len(os.Args); i++ {
		if os.Args[i] == "--control-url" && i+1 < len(os.Args) {
			controlURL = os.Args[i+1]
			i++
		} else {
			cmdArgs = append(cmdArgs, os.Args[i])
		}
	}

	if len(cmdArgs) == 0 {
		printHelp()
		os.Exit(1)
	}

	command := cmdArgs[0]
	client := control.NewClient(controlURL)
	client.SetAuthToken(os.Getenv("SOVEREIGN_REGISTRATION_TOKEN"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	switch command {
	case "status":
		fmt.Printf("Connecting to NeroNet Control Plane at %s...\n", controlURL)
		bridges, err := client.DiscoverExitBridges(ctx, "", 0, "", 100)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		fmt.Println("\n=======================================================")
		fmt.Println("                NERONET MESH CLUSTER STATUS            ")
		fmt.Println("=======================================================")
		fmt.Printf("Control Plane: %s\n", controlURL)
		fmt.Printf("Active Exit Bridges: %d\n", len(bridges))
		fmt.Println("Mesh Overlay CIDR:   100.64.0.0/10")
		fmt.Println("=======================================================")

	case "peers":
		country := ""
		if len(cmdArgs) > 1 {
			country = strings.ToUpper(cmdArgs[1])
		}

		bridges, err := client.DiscoverExitBridges(ctx, country, 0, "", 50)
		if err != nil {
			fmt.Printf("Error discovering peers: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("\nDiscovered %d Exit Bridges (Country: %s):\n\n", len(bridges), country)
		fmt.Printf("%-18s %-8s %-12s %-16s %-8s\n", "NODE ID", "COUNTRY", "CLASS", "OVERLAY IP", "SCORE")
		fmt.Println(strings.Repeat("-", 68))

		for _, b := range bridges {
			fmt.Printf("%-18s %-8s %-12s %-16s %-8.1f\n",
				b.NodeID,
				b.Capability.CountryCode,
				b.Capability.IPClass,
				b.OverlayIPv4,
				b.Score,
			)
		}
		fmt.Println()

	case "circuit":
		country := "US"
		if len(cmdArgs) > 1 {
			country = strings.ToUpper(cmdArgs[1])
		}

		circ, err := client.RequestCircuitPath(ctx, country)
		if err != nil {
			fmt.Printf("Error building circuit: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("\n%d-hop onion path (ID: 0x%08X, exit country: %s):\n\n", len(circ.Hops), circ.CircuitID, country)
		for _, hop := range circ.Hops {
			// Hop indices are zero-based. The previous labels tested for 1 and 3, so
			// every hop was named wrongly -- the exit was printed as "Intermediate".
			role := "Intermediate"
			switch hop.HopIndex {
			case 0:
				role = "Entry relay"
			case len(circ.Hops) - 1:
				role = "Exit bridge"
			}

			keyPrefix := hop.PublicKeyHex
			if len(keyPrefix) > 16 {
				keyPrefix = keyPrefix[:16]
			}

			fmt.Printf(" [Hop %d] %-13s | Node ID: %-20s | Key: %s...\n",
				hop.HopIndex, role, hop.NodeID, keyPrefix,
			)
		}

		// This is a selected path, not an established circuit: no handshake has run
		// and no cell has been sent. Saying "ESTABLISHED" here claimed otherwise.
		fmt.Printf("\nPath selected. Valid until %s.\n",
			time.Unix(int64(circ.ExpiryTimestamp), 0).Format(time.RFC3339))

		if circ.Diversity.DistinctOperators && circ.Diversity.DistinctNetworks {
			fmt.Println("Independence: every hop has a different operator and network.")
		} else {
			fmt.Printf("Independence: LIMITED — %s\n", circ.Diversity.Note)
		}

	case "keygen":
		kp, err := crypto.GenerateKeypair()
		if err != nil {
			fmt.Printf("Keygen error: %v\n", err)
			os.Exit(1)
		}

		nodeID := control.GenerateNodeID(kp.PublicKey)
		fmt.Println("\nGenerated NeroNet Curve25519 Keypair:")
		fmt.Printf("  Node ID:     %s\n", nodeID)
		fmt.Printf("  Public Key:  %s\n", hex.EncodeToString(kp.PublicKey[:]))
		fmt.Printf("  Private Key: %s\n", hex.EncodeToString(kp.PrivateKey[:]))
		fmt.Println("\nStore your private key securely in platform keystore / environment variable.")

	case "stun-ping":
		if len(cmdArgs) < 2 {
			fmt.Println("Usage: sovereign-cli stun-ping <host:port>")
			os.Exit(1)
		}
		target := cmdArgs[1]
		fmt.Printf("Sending STUN Binding Request to %s...\n", target)

		start := time.Now()
		mapped, err := nat.QuerySTUN(target, 3*time.Second, nil)
		if err != nil {
			fmt.Printf("STUN Ping failed: %v\n", err)
			os.Exit(1)
		}
		rtt := time.Since(start)

		fmt.Printf("STUN Reply Received in %v!\n", rtt)
		fmt.Printf("  Public Mapped Endpoint: %s\n", mapped.String())

	case "help":
		printHelp()

	default:
		fmt.Printf("Unknown command: %s\n", command)
		printHelp()
		os.Exit(1)
	}
}
