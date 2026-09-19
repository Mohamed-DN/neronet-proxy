package posture

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrPolicyNotFound = errors.New("posture policy not found")
)

// PostureCheckType specifies the verification check
type PostureCheckType string

const (
	CheckOSVersion     PostureCheckType = "OS_VERSION"
	CheckClientVersion PostureCheckType = "CLIENT_VERSION"
	CheckGeoFencing    PostureCheckType = "GEO_FENCING"
	CheckSecurityState PostureCheckType = "SECURITY_STATE"
)

// OSVersionRule defines min OS version requirements per platform
type OSVersionRule struct {
	OSName     string `json:"os_name"` // "linux", "darwin", "windows", "android"
	MinVersion string `json:"min_version"`
}

// GeoFencingRule defines allowed/prohibited geographic jurisdictions and ASNs
type GeoFencingRule struct {
	AllowedCountries    []string `json:"allowed_countries"` // ISO 3166-1 alpha-2
	ProhibitedCountries []string `json:"prohibited_countries"`
	AllowedASNs         []uint32 `json:"allowed_asns"`
}

// SecurityStateRule defines host-level hardening requirements
type SecurityStateRule struct {
	RequireDiskEncryption bool `json:"require_disk_encryption"`
	RequireFirewall       bool `json:"require_firewall"`
	RequireRootless       bool `json:"require_rootless"`
}

// PosturePolicy aggregates compliance requirements for groups of peers
type PosturePolicy struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Enabled      bool              `json:"enabled"`
	TargetGroups []string          `json:"target_groups"`
	MinClientVer string            `json:"min_client_version"`
	OSRules      []OSVersionRule   `json:"os_rules"`
	GeoRule      GeoFencingRule    `json:"geo_rule"`
	SecurityRule SecurityStateRule `json:"security_rule"`
	CreatedAt    time.Time         `json:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at"`
}

// PeerAttestation represents the telemetry payload submitted by the peer.
//
// A field the node did not measure must stay unset rather than carry a plausible
// value. The zero value is the "not measured" marker for everything except the two
// security booleans, which need a third state and are therefore pointers:
//
//	ASN == 0            not measured
//	OSVersion == ""     not measured
//	CountryCode == ""   not declared (it is self-declared, never measured)
//	DiskEncrypted nil   not measured (JSON null)
//	FirewallActive nil  not measured (JSON null)
//
// The JSON field names are part of the wire contract with the control plane and do
// not change. A node built before the pointers existed sends a bare `true`/`false`,
// which still decodes; a node that omits the field decodes to nil, and nil must
// never be read as true.
type PeerAttestation struct {
	NodeID        string `json:"node_id"`
	OSName        string `json:"os_name"`
	OSVersion     string `json:"os_version"`
	ClientVersion string `json:"client_version"`
	CountryCode   string `json:"country_code"`
	ASN           uint32 `json:"asn"`

	// Nil means the node did not measure host disk encryption, which is not the
	// same as measuring it and finding it off.
	DiskEncrypted *bool `json:"disk_encrypted"`

	// Nil means the node did not measure the host firewall.
	FirewallActive *bool `json:"firewall_active"`

	// IsRootless is measured on every platform the node runs on, so it has no
	// unknown state.
	IsRootless   bool      `json:"is_rootless"`
	TimestampUTC time.Time `json:"timestamp_utc"`
}

// PostureStatus is the outcome of evaluating an attestation against the policies
// that apply to a peer.
type PostureStatus string

const (
	// StatusVerifiedCompliant means every required check was reported and passed.
	StatusVerifiedCompliant PostureStatus = "verified_compliant"

	// StatusNonCompliant means at least one reported check failed.
	StatusNonCompliant PostureStatus = "non_compliant"

	// StatusUnverified means nothing failed but at least one required check was
	// not measured. It is not compliance: the node has proved nothing.
	StatusUnverified PostureStatus = "unverified"
)

// PostureResult indicates the outcome of a posture evaluation
type PostureResult struct {
	// Status is the full answer. Compliant below is kept because callers already
	// branch on it, but it cannot distinguish "failed" from "never measured", which
	// is exactly the distinction this type exists to carry.
	Status PostureStatus `json:"status"`

	// Compliant is true only for StatusVerifiedCompliant. An unverified result is
	// not compliant and is not a violation either; branch on Quarantine, or on
	// Status, to tell the two apart.
	Compliant       bool     `json:"compliant"`
	Quarantine      bool     `json:"quarantine"`
	FailedChecks    []string `json:"failed_checks"`
	UnknownChecks   []string `json:"unknown_checks"`
	ViolationReason string   `json:"violation_reason"`
}

// QuarantineRecord stores information about a quarantined peer
type QuarantineRecord struct {
	NodeID        string    `json:"node_id"`
	Reason        string    `json:"reason"`
	FailedChecks  []string  `json:"failed_checks"`
	QuarantinedAt time.Time `json:"quarantined_at"`
}

// PeerQuarantineManager tracks quarantined peers
type PeerQuarantineManager struct {
	mu          sync.RWMutex
	quarantined map[string]*QuarantineRecord
}

// NewPeerQuarantineManager creates a new quarantine manager
func NewPeerQuarantineManager() *PeerQuarantineManager {
	return &PeerQuarantineManager{
		quarantined: make(map[string]*QuarantineRecord),
	}
}

// QuarantinePeer marks a peer as quarantined
func (qm *PeerQuarantineManager) QuarantinePeer(nodeID, reason string, failedChecks []string) {
	qm.mu.Lock()
	defer qm.mu.Unlock()

	qm.quarantined[nodeID] = &QuarantineRecord{
		NodeID:        nodeID,
		Reason:        reason,
		FailedChecks:  failedChecks,
		QuarantinedAt: time.Now().UTC(),
	}
}

// UnquarantinePeer removes a peer from quarantine
func (qm *PeerQuarantineManager) UnquarantinePeer(nodeID string) {
	qm.mu.Lock()
	defer qm.mu.Unlock()
	delete(qm.quarantined, nodeID)
}

// IsQuarantined checks if a peer is currently quarantined
func (qm *PeerQuarantineManager) IsQuarantined(nodeID string) bool {
	qm.mu.RLock()
	defer qm.mu.RUnlock()
	_, exists := qm.quarantined[nodeID]
	return exists
}

// GetQuarantineRecord retrieves details about a quarantined peer
func (qm *PeerQuarantineManager) GetQuarantineRecord(nodeID string) (*QuarantineRecord, bool) {
	qm.mu.RLock()
	defer qm.mu.RUnlock()
	rec, exists := qm.quarantined[nodeID]
	if !exists {
		return nil, false
	}
	recCopy := *rec
	return &recCopy, true
}

// ListQuarantinedPeers returns all currently quarantined peer records
func (qm *PeerQuarantineManager) ListQuarantinedPeers() []*QuarantineRecord {
	qm.mu.RLock()
	defer qm.mu.RUnlock()

	list := make([]*QuarantineRecord, 0, len(qm.quarantined))
	for _, rec := range qm.quarantined {
		recCopy := *rec
		list = append(list, &recCopy)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].NodeID < list[j].NodeID
	})
	return list
}

// QuarantineCount returns total quarantined peers
func (qm *PeerQuarantineManager) QuarantineCount() int {
	qm.mu.RLock()
	defer qm.mu.RUnlock()
	return len(qm.quarantined)
}

// PostureEngine evaluates peer attestations against active policies
type PostureEngine struct {
	mu            sync.RWMutex
	policies      map[string]*PosturePolicy
	quarantineMgr *PeerQuarantineManager
	epoch         uint64
}

// NewPostureEngine initializes the posture verification engine
func NewPostureEngine() *PostureEngine {
	return &PostureEngine{
		policies:      make(map[string]*PosturePolicy),
		quarantineMgr: NewPeerQuarantineManager(),
		epoch:         1,
	}
}

// QuarantineManager returns the internal quarantine manager
func (pe *PostureEngine) QuarantineManager() *PeerQuarantineManager {
	return pe.quarantineMgr
}

// UpsertPolicy adds or updates a posture policy
func (pe *PostureEngine) UpsertPolicy(p *PosturePolicy) error {
	if p.ID == "" {
		return fmt.Errorf("posture policy ID cannot be empty")
	}

	pe.mu.Lock()
	defer pe.mu.Unlock()

	now := time.Now()
	if existing, ok := pe.policies[p.ID]; ok {
		p.CreatedAt = existing.CreatedAt
	} else if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now

	pe.policies[p.ID] = p
	pe.epoch++
	return nil
}

// GetPolicy retrieves a posture policy by ID
func (pe *PostureEngine) GetPolicy(id string) (*PosturePolicy, bool) {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	p, ok := pe.policies[id]
	if !ok {
		return nil, false
	}
	pCopy := *p
	return &pCopy, true
}

// ListPolicies returns all posture policies sorted by ID
func (pe *PostureEngine) ListPolicies() []*PosturePolicy {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	list := make([]*PosturePolicy, 0, len(pe.policies))
	for _, p := range pe.policies {
		pCopy := *p
		list = append(list, &pCopy)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].ID < list[j].ID
	})
	return list
}

// DeletePolicy removes a posture policy by ID
func (pe *PostureEngine) DeletePolicy(id string) error {
	pe.mu.Lock()
	defer pe.mu.Unlock()

	if _, ok := pe.policies[id]; !ok {
		return ErrPolicyNotFound
	}
	delete(pe.policies, id)
	pe.epoch++
	return nil
}

// Epoch returns the current posture engine epoch
func (pe *PostureEngine) Epoch() uint64 {
	pe.mu.RLock()
	defer pe.mu.RUnlock()
	return pe.epoch
}

// EvaluateAttestation validates peer telemetry against applicable policies.
//
// Three outcomes, not two. A required check the node did not measure leaves the peer
// unverified: it is not evidence of compliance and it is not a violation either.
// Collapsing that third state into "compliant" is what let a fleet report itself
// fully hardened without a single measurement.
func (pe *PostureEngine) EvaluateAttestation(att *PeerAttestation, peerGroups []string) PostureResult {
	if att == nil {
		// No attestation at all is the strongest form of "not measured".
		return PostureResult{
			Status:        StatusUnverified,
			UnknownChecks: []string{"no attestation was submitted"},
		}
	}

	pe.mu.RLock()
	policies := make([]*PosturePolicy, 0, len(pe.policies))
	for _, p := range pe.policies {
		policies = append(policies, p)
	}
	pe.mu.RUnlock()

	groupSet := make(map[string]bool)
	for _, g := range peerGroups {
		groupSet[g] = true
	}
	groupSet["group:all"] = true

	var failed []string
	var unknown []string

	for _, policy := range policies {
		if !policy.Enabled {
			continue
		}

		applies := false
		if len(policy.TargetGroups) == 0 {
			applies = true
		} else {
			for _, tg := range policy.TargetGroups {
				if groupSet[tg] {
					applies = true
					break
				}
			}
		}
		if !applies {
			continue
		}

		// 1. Client Version Check
		if policy.MinClientVer != "" {
			if att.ClientVersion == "" {
				// This used to be skipped, which silently passed the check.
				unknown = append(unknown, "client version was not reported")
			} else if CompareSemver(att.ClientVersion, policy.MinClientVer) < 0 {
				failed = append(failed, fmt.Sprintf("Client version %s below required min %s", att.ClientVersion, policy.MinClientVer))
			}
		}

		// 2. OS Version Check
		for _, osRule := range policy.OSRules {
			if !strings.EqualFold(att.OSName, osRule.OSName) || osRule.MinVersion == "" {
				continue
			}
			if att.OSVersion == "" {
				// An empty version compares below every minimum, so this used to be
				// reported as a violation. The node did not measure it.
				unknown = append(unknown, fmt.Sprintf("OS version was not reported for %s", osRule.OSName))
				continue
			}
			if CompareSemver(att.OSVersion, osRule.MinVersion) < 0 {
				failed = append(failed, fmt.Sprintf("OS %s version %s below required min %s", att.OSName, att.OSVersion, osRule.MinVersion))
			}
		}

		// 3. Geo-Fencing Check
		targetCC := strings.ToUpper(strings.TrimSpace(att.CountryCode))
		if targetCC != "" {
			// Blacklist check
			if len(policy.GeoRule.ProhibitedCountries) > 0 {
				for _, pc := range policy.GeoRule.ProhibitedCountries {
					if strings.ToUpper(strings.TrimSpace(pc)) == targetCC {
						failed = append(failed, fmt.Sprintf("Node located in prohibited country %s", targetCC))
						break
					}
				}
			}

			// Whitelist check
			if len(policy.GeoRule.AllowedCountries) > 0 {
				allowed := false
				for _, ac := range policy.GeoRule.AllowedCountries {
					if strings.ToUpper(strings.TrimSpace(ac)) == targetCC {
						allowed = true
						break
					}
				}
				if !allowed {
					failed = append(failed, fmt.Sprintf("Country %s is not in allowed compliance list", targetCC))
				}
			}
		}

		// ASN Whitelist check. ASN 0 is the unmeasured value, not an ASN outside the
		// list: the node does not resolve its own ASN.
		if len(policy.GeoRule.AllowedASNs) > 0 {
			if att.ASN == 0 {
				unknown = append(unknown, "ASN was not reported")
			} else {
				asnAllowed := false
				for _, asn := range policy.GeoRule.AllowedASNs {
					if asn == att.ASN {
						asnAllowed = true
						break
					}
				}
				if !asnAllowed {
					failed = append(failed, fmt.Sprintf("ASN %d is not in allowed compliance list", att.ASN))
				}
			}
		}

		// 4. Security State Check.
		//
		// A nil pointer is "the node did not look", and it must not fall through to
		// the false branch. The whole fleet reported disk encryption and a live
		// firewall because these two values were constants in the node binary.
		if policy.SecurityRule.RequireDiskEncryption {
			switch {
			case att.DiskEncrypted == nil:
				unknown = append(unknown, "host disk encryption was not measured")
			case !*att.DiskEncrypted:
				failed = append(failed, "Host disk encryption is not enabled")
			}
		}
		if policy.SecurityRule.RequireFirewall {
			switch {
			case att.FirewallActive == nil:
				unknown = append(unknown, "host local firewall was not measured")
			case !*att.FirewallActive:
				failed = append(failed, "Host local firewall is disabled")
			}
		}
		if policy.SecurityRule.RequireRootless && !att.IsRootless {
			failed = append(failed, "Process running with privileged root execution")
		}
	}

	if len(failed) > 0 {
		res := PostureResult{
			Status:          StatusNonCompliant,
			Compliant:       false,
			Quarantine:      true,
			FailedChecks:    failed,
			UnknownChecks:   unknown,
			ViolationReason: strings.Join(failed, "; "),
		}
		if att.NodeID != "" {
			pe.quarantineMgr.QuarantinePeer(att.NodeID, res.ViolationReason, failed)
		}
		return res
	}

	if len(unknown) > 0 {
		// Nothing failed, but nothing was proved either. The quarantine state is left
		// exactly as it is: lifting it here would clear a quarantine imposed for a
		// check the node has now simply stopped reporting.
		return PostureResult{
			Status:        StatusUnverified,
			Compliant:     false,
			Quarantine:    false,
			UnknownChecks: unknown,
		}
	}

	if att.NodeID != "" {
		pe.quarantineMgr.UnquarantinePeer(att.NodeID)
	}

	return PostureResult{
		Status:     StatusVerifiedCompliant,
		Compliant:  true,
		Quarantine: false,
	}
}

// CompareSemver compares two version strings (-1: a < b, 0: a == b, 1: a > b)
func CompareSemver(a, b string) int {
	aClean := strings.TrimPrefix(strings.TrimSpace(a), "v")
	bClean := strings.TrimPrefix(strings.TrimSpace(b), "v")

	if aClean == bClean {
		return 0
	}

	// Strip build metadata
	if idx := strings.Index(aClean, "+"); idx >= 0 {
		aClean = aClean[:idx]
	}
	if idx := strings.Index(bClean, "+"); idx >= 0 {
		bClean = bClean[:idx]
	}

	// Separate prerelease
	aPre := ""
	bPre := ""
	if idx := strings.Index(aClean, "-"); idx >= 0 {
		aPre = aClean[idx+1:]
		aClean = aClean[:idx]
	}
	if idx := strings.Index(bClean, "-"); idx >= 0 {
		bPre = bClean[idx+1:]
		bClean = bClean[:idx]
	}

	aParts := strings.Split(aClean, ".")
	bParts := strings.Split(bClean, ".")

	maxLen := len(aParts)
	if len(bParts) > maxLen {
		maxLen = len(bParts)
	}

	for i := 0; i < maxLen; i++ {
		var aNum, bNum uint64
		if i < len(aParts) {
			aNum, _ = strconv.ParseUint(aParts[i], 10, 64)
		}
		if i < len(bParts) {
			bNum, _ = strconv.ParseUint(bParts[i], 10, 64)
		}

		if aNum < bNum {
			return -1
		}
		if aNum > bNum {
			return 1
		}
	}

	// If main numbers match, a release without prerelease is higher than a prerelease
	if aPre == "" && bPre != "" {
		return 1
	}
	if aPre != "" && bPre == "" {
		return -1
	}
	if aPre != "" && bPre != "" {
		return strings.Compare(aPre, bPre)
	}

	return 0
}
