package crypto

import (
	"sync"
)

const (
	WindowSizeBits = 1024
	WindowWords    = WindowSizeBits / 64 // 16 uint64 words
)

// AntiReplayWindow implements an O(1) 1024-packet sliding window filter.
// It detects and prevents replay attacks and out-of-window packets before invoking
// expensive cryptographic AEAD decryption.
type AntiReplayWindow struct {
	mu     sync.Mutex
	maxSeq uint64
	bitmap [WindowWords]uint64
}

// NewAntiReplayWindow creates an initialized AntiReplayWindow.
func NewAntiReplayWindow() *AntiReplayWindow {
	return &AntiReplayWindow{
		maxSeq: 0,
	}
}

// Check checks if the sequence counter has been seen or is outside the window without mutating state.
// Returns true if valid and not seen; false if duplicate or outside window.
func (w *AntiReplayWindow) Check(seq uint64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Initial packet
	if w.maxSeq == 0 && w.bitmap[0] == 0 {
		return true
	}

	if seq > w.maxSeq {
		return true
	}

	// seq <= w.maxSeq
	diff := w.maxSeq - seq
	if diff >= WindowSizeBits {
		// Too old: falls behind the 1024-packet sliding window
		return false
	}

	wordIdx := diff / 64
	bitIdx := diff % 64

	// Check if already received
	if (w.bitmap[wordIdx] & (uint64(1) << bitIdx)) != 0 {
		return false // Duplicate packet!
	}

	return true
}

// Add marks the sequence counter as received in the window.
// Returns true if successfully committed, or false if duplicate/too old.
func (w *AntiReplayWindow) Add(seq uint64) bool {
	return w.CheckAndAdd(seq)
}

// CheckAndAdd checks if the sequence counter has been seen or is outside the window.
// If valid and not seen, it adds the counter to the window and returns true.
// If invalid or duplicate, returns false.
func (w *AntiReplayWindow) CheckAndAdd(seq uint64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Initial packet
	if w.maxSeq == 0 && w.bitmap[0] == 0 {
		w.maxSeq = seq
		w.bitmap[0] |= 1
		return true
	}

	if seq > w.maxSeq {
		diff := seq - w.maxSeq
		if diff >= WindowSizeBits {
			// Window shifted completely beyond 1024 bits
			for i := range w.bitmap {
				w.bitmap[i] = 0
			}
		} else {
			w.shiftRight(diff)
		}
		w.maxSeq = seq
		w.bitmap[0] |= 1
		return true
	}

	// seq <= w.maxSeq
	diff := w.maxSeq - seq
	if diff >= WindowSizeBits {
		// Too old: falls behind the 1024-packet sliding window
		return false
	}

	wordIdx := diff / 64
	bitIdx := diff % 64

	// Check if already received
	if (w.bitmap[wordIdx] & (uint64(1) << bitIdx)) != 0 {
		return false // Duplicate packet!
	}

	// Mark as received
	w.bitmap[wordIdx] |= (uint64(1) << bitIdx)
	return true
}

// shiftRight shifts the bitmap array by n bits (moving older sequence bits higher)
func (w *AntiReplayWindow) shiftRight(n uint64) {
	wordShift := int(n / 64)
	bitShift := n % 64

	if wordShift >= WindowWords {
		for i := range w.bitmap {
			w.bitmap[i] = 0
		}
		return
	}

	if wordShift > 0 {
		for i := WindowWords - 1; i >= wordShift; i-- {
			w.bitmap[i] = w.bitmap[i-wordShift]
		}
		for i := 0; i < wordShift; i++ {
			w.bitmap[i] = 0
		}
	}

	if bitShift > 0 {
		var carry uint64
		for i := 0; i < WindowWords; i++ {
			newCarry := w.bitmap[i] >> (64 - bitShift)
			w.bitmap[i] = (w.bitmap[i] << bitShift) | carry
			carry = newCarry
		}
	}
}

// Reset clears the anti-replay window state
func (w *AntiReplayWindow) Reset() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.maxSeq = 0
	for i := range w.bitmap {
		w.bitmap[i] = 0
	}
}
