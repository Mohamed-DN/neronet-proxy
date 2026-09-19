package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseDotEnv(t *testing.T) {
	content := `
# Global Cluster Settings
SOVEREIGN_CLUSTER_NAME=test-cluster
SOVEREIGN_ENVIRONMENT="production"
SOVEREIGN_DOMAIN='mesh.example.org' # Inline comment

export SOVEREIGN_SSH_PORT=2222
EMPTY_VAL=
QUOTED_WITH_SPACES="value with spaces and = sign"
`
	parsed := ParseDotEnv(content)

	expected := map[string]string{
		"SOVEREIGN_CLUSTER_NAME": "test-cluster",
		"SOVEREIGN_ENVIRONMENT":  "production",
		"SOVEREIGN_DOMAIN":       "mesh.example.org",
		"SOVEREIGN_SSH_PORT":     "2222",
		"EMPTY_VAL":              "",
		"QUOTED_WITH_SPACES":     "value with spaces and = sign",
	}

	for k, exp := range expected {
		got, exists := parsed[k]
		if !exists {
			t.Errorf("expected key %q to exist in parsed map", k)
		} else if got != exp {
			t.Errorf("key %q: expected %q, got %q", k, exp, got)
		}
	}
}

func TestLoadDotEnv(t *testing.T) {
	tmpDir := t.TempDir()
	envFile := filepath.Join(tmpDir, "test.env")

	data := `
SOV_LOAD_TEST_A=alpha
SOV_LOAD_TEST_B=beta_${SOV_LOAD_TEST_A}
`
	if err := os.WriteFile(envFile, []byte(data), 0600); err != nil {
		t.Fatalf("failed to write test env file: %v", err)
	}

	// Set existing override in process environment
	_ = os.Setenv("SOV_LOAD_TEST_A", "override_alpha")
	defer os.Unsetenv("SOV_LOAD_TEST_A")
	defer os.Unsetenv("SOV_LOAD_TEST_B")

	if err := LoadDotEnv(envFile); err != nil {
		t.Fatalf("LoadDotEnv failed: %v", err)
	}

	if val := os.Getenv("SOV_LOAD_TEST_A"); val != "override_alpha" {
		t.Errorf("LoadDotEnv should not override existing env var: expected override_alpha, got %q", val)
	}
	if val := os.Getenv("SOV_LOAD_TEST_B"); val != "beta_override_alpha" {
		t.Errorf("LoadDotEnv should expand nested variables: expected beta_override_alpha, got %q", val)
	}
}

func TestGetEnvHelpers(t *testing.T) {
	_ = os.Setenv("TEST_ENV_STR", "hello")
	_ = os.Setenv("TEST_ENV_INT", "42")
	_ = os.Setenv("TEST_ENV_BOOL_1", "true")
	_ = os.Setenv("TEST_ENV_BOOL_2", "off")
	_ = os.Setenv("TEST_ENV_DUR", "30s")
	_ = os.Setenv("TEST_ENV_SLICE", "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16")

	defer func() {
		os.Unsetenv("TEST_ENV_STR")
		os.Unsetenv("TEST_ENV_INT")
		os.Unsetenv("TEST_ENV_BOOL_1")
		os.Unsetenv("TEST_ENV_BOOL_2")
		os.Unsetenv("TEST_ENV_DUR")
		os.Unsetenv("TEST_ENV_SLICE")
	}()

	// String
	if val := GetEnv("TEST_ENV_STR", "fallback"); val != "hello" {
		t.Errorf("GetEnv expected hello, got %s", val)
	}
	if val := GetEnv("NONEXISTENT_KEY", "fallback"); val != "fallback" {
		t.Errorf("GetEnv expected fallback, got %s", val)
	}

	// Int
	if val := GetEnvInt("TEST_ENV_INT", 10); val != 42 {
		t.Errorf("GetEnvInt expected 42, got %d", val)
	}
	if val := GetEnvInt("NONEXISTENT_KEY", 10); val != 10 {
		t.Errorf("GetEnvInt expected 10, got %d", val)
	}

	// Bool
	if val := GetEnvBool("TEST_ENV_BOOL_1", false); !val {
		t.Errorf("GetEnvBool expected true, got false")
	}
	if val := GetEnvBool("TEST_ENV_BOOL_2", true); val {
		t.Errorf("GetEnvBool expected false, got true")
	}
	if val := GetEnvBool("NONEXISTENT_KEY", true); !val {
		t.Errorf("GetEnvBool expected fallback true, got false")
	}

	// Duration
	if val := GetEnvDuration("TEST_ENV_DUR", 5*time.Second); val != 30*time.Second {
		t.Errorf("GetEnvDuration expected 30s, got %v", val)
	}
	if val := GetEnvDuration("NONEXISTENT_KEY", 5*time.Second); val != 5*time.Second {
		t.Errorf("GetEnvDuration expected 5s, got %v", val)
	}

	// Slice
	slice := GetEnvSlice("TEST_ENV_SLICE", nil)
	if len(slice) != 3 || slice[0] != "10.0.0.0/8" || slice[1] != "172.16.0.0/12" || slice[2] != "192.168.0.0/16" {
		t.Errorf("GetEnvSlice unexpected result: %v", slice)
	}
}

func TestGetSecretAndMasking(t *testing.T) {
	tmpDir := t.TempDir()
	SetSecretDir(tmpDir)
	defer SetSecretDir("")

	// 1. From Mounted Secret File
	secretFile := filepath.Join(tmpDir, "REALITY_PRIVATE_KEY")
	if err := os.WriteFile(secretFile, []byte("file-secret-key-12345"), 0600); err != nil {
		t.Fatalf("failed to write secret file: %v", err)
	}

	if s := GetSecret("REALITY_PRIVATE_KEY", ""); s != "file-secret-key-12345" {
		t.Errorf("GetSecret from file expected file-secret-key-12345, got %q", s)
	}

	// 2. Direct Environment Variable Overrides File
	_ = os.Setenv("REALITY_PRIVATE_KEY", "env-secret-key-67890")
	defer os.Unsetenv("REALITY_PRIVATE_KEY")

	if s := GetSecret("REALITY_PRIVATE_KEY", ""); s != "env-secret-key-67890" {
		t.Errorf("GetSecret from env expected env-secret-key-67890, got %q", s)
	}

	// 3. Fallback Generation
	randomSecret := GetSecret("NONEXISTENT_SECRET_RANDOM", "")
	if len(randomSecret) < 32 {
		t.Errorf("expected dynamically generated secure secret >= 32 chars, got %q", randomSecret)
	}

	// 4. Secret Masking
	if masked := MaskSecret("supersecretpassphrase"); masked != "sup****ase" {
		t.Errorf("MaskSecret expected sup****ase, got %q", masked)
	}
	if masked := MaskSecret("short"); masked != "******" {
		t.Errorf("MaskSecret expected ******, got %q", masked)
	}
	if masked := MaskSecret(""); masked != "<empty>" {
		t.Errorf("MaskSecret expected <empty>, got %q", masked)
	}
}
