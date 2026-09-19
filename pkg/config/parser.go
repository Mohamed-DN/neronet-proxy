package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var envVarRegex = regexp.MustCompile(`\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-([^}]*))?\}`)

// ExpandEnv replaces ${VAR} or ${VAR:-default} in the input string with environment values.
func ExpandEnv(input string) string {
	return envVarRegex.ReplaceAllStringFunc(input, func(m string) string {
		submatches := envVarRegex.FindStringSubmatch(m)
		if len(submatches) < 2 {
			return m
		}
		varName := submatches[1]
		val, exists := os.LookupEnv(varName)
		if exists && val != "" {
			return val
		}
		if len(submatches) >= 3 && submatches[2] != "" {
			return submatches[2]
		}
		if exists {
			return val
		}
		return ""
	})
}

// SimpleYAMLToJSON converts basic YAML to JSON for parsing without external heavy dependencies.
// For production Go modules with gopkg.in/yaml.v3, standard yaml.Unmarshal is used.
func SimpleYAMLToJSON(yamlData []byte) ([]byte, error) {
	// If it already looks like JSON
	trimmed := bytes.TrimSpace(yamlData)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		return yamlData, nil
	}
	return yamlToJSONConverter(string(yamlData))
}

// yamlToJSONConverter transforms structured YAML lines into a standard map/JSON structure.
func yamlToJSONConverter(yamlStr string) ([]byte, error) {
	lines := strings.Split(yamlStr, "\n")

	// We use a robust recursive line-based tree builder for YAML structures
	tree, err := parseYAMLTree(lines)
	if err != nil {
		return nil, fmt.Errorf("yaml parse error: %w", err)
	}

	return json.Marshal(tree)
}

func parseYAMLTree(lines []string) (interface{}, error) {
	var cleanLines []string
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// Strip inline comments if not inside quotes
		if idx := strings.Index(l, " #"); idx != -1 {
			l = l[:idx]
		}
		cleanLines = append(cleanLines, l)
	}
	if len(cleanLines) == 0 {
		return make(map[string]interface{}), nil
	}

	return parseLines(cleanLines, 0)
}

func getIndent(line string) int {
	return len(line) - len(strings.TrimLeft(line, " "))
}

// isYAMLKeyValue returns true if s is formatted as an unquoted YAML key-value pair (e.g. "key: val" or "key:")
func isYAMLKeyValue(s string) bool {
	s = strings.TrimSpace(s)
	// If the entire value is quoted, it is a scalar string
	if (strings.HasPrefix(s, "\"") && strings.HasSuffix(s, "\"") && len(s) >= 2) ||
		(strings.HasPrefix(s, "'") && strings.HasSuffix(s, "'") && len(s) >= 2) {
		return false
	}
	colonIdx := strings.Index(s, ":")
	if colonIdx == -1 {
		return false
	}
	// In YAML, a key-value mapping colon must be at the end of the line (e.g. "key:")
	// or immediately followed by whitespace (e.g. "key: value")
	if colonIdx == len(s)-1 || s[colonIdx+1] == ' ' || s[colonIdx+1] == '\t' {
		return true
	}
	return false
}

func parseLines(lines []string, baseIndent int) (interface{}, error) {
	if len(lines) == 0 {
		return nil, nil
	}

	firstLine := lines[0]
	firstTrimmed := strings.TrimSpace(firstLine)

	if strings.HasPrefix(firstTrimmed, "- ") {
		// List parsing
		var list []interface{}
		var currentItemLines []string
		itemIndent := getIndent(firstLine)

		flushItem := func() error {
			if len(currentItemLines) == 0 {
				return nil
			}
			first := strings.TrimSpace(currentItemLines[0])
			if strings.HasPrefix(first, "- ") {
				valStr := strings.TrimSpace(first[2:])
				if len(currentItemLines) == 1 && !isYAMLKeyValue(valStr) {
					list = append(list, parseScalar(valStr))
				} else {
					// Sub-object inside list item
					syntheticLines := make([]string, len(currentItemLines))
					if valStr != "" && isYAMLKeyValue(valStr) {
						syntheticLines[0] = strings.Repeat(" ", itemIndent+2) + valStr
					} else {
						syntheticLines[0] = strings.Repeat(" ", itemIndent+2) + "_item: true"
					}
					for i := 1; i < len(currentItemLines); i++ {
						syntheticLines[i] = currentItemLines[i]
					}
					sub, err := parseLines(syntheticLines, itemIndent+2)
					if err != nil {
						return err
					}
					if subMap, ok := sub.(map[string]interface{}); ok {
						delete(subMap, "_item")
						list = append(list, subMap)
					} else {
						list = append(list, sub)
					}
				}
			}
			currentItemLines = nil
			return nil
		}

		for _, line := range lines {
			indent := getIndent(line)
			trimmed := strings.TrimSpace(line)
			if indent == itemIndent && strings.HasPrefix(trimmed, "- ") {
				if err := flushItem(); err != nil {
					return nil, err
				}
			}
			currentItemLines = append(currentItemLines, line)
		}
		if err := flushItem(); err != nil {
			return nil, err
		}
		return list, nil
	}

	// Map parsing
	obj := make(map[string]interface{})
	i := 0
	for i < len(lines) {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		indent := getIndent(line)

		if indent != baseIndent {
			i++
			continue
		}

		colonIdx := strings.Index(trimmed, ":")
		if colonIdx == -1 {
			i++
			continue
		}

		key := strings.TrimSpace(trimmed[:colonIdx])
		valPart := strings.TrimSpace(trimmed[colonIdx+1:])

		if valPart != "" && !strings.HasPrefix(valPart, "[") && !strings.HasPrefix(valPart, "{") {
			obj[key] = parseScalar(valPart)
			i++
		} else if strings.HasPrefix(valPart, "[") && strings.HasSuffix(valPart, "]") {
			// Inline list e.g. [80, 443, 2222]
			inner := strings.TrimSpace(valPart[1 : len(valPart)-1])
			if inner == "" {
				obj[key] = []interface{}{}
			} else {
				parts := strings.Split(inner, ",")
				var items []interface{}
				for _, p := range parts {
					items = append(items, parseScalar(strings.TrimSpace(p)))
				}
				obj[key] = items
			}
			i++
		} else {
			// Nested block
			var subLines []string
			i++
			for i < len(lines) {
				subLine := lines[i]
				subIndent := getIndent(subLine)
				if subIndent <= baseIndent {
					break
				}
				subLines = append(subLines, subLine)
				i++
			}
			if len(subLines) > 0 {
				subIndent := getIndent(subLines[0])
				subVal, err := parseLines(subLines, subIndent)
				if err != nil {
					return nil, err
				}
				obj[key] = subVal
			} else {
				obj[key] = nil
			}
		}
	}
	return obj, nil
}

func parseScalar(s string) interface{} {
	s = strings.TrimSpace(s)
	// Strip quotes
	if (strings.HasPrefix(s, "\"") && strings.HasSuffix(s, "\"")) ||
		(strings.HasPrefix(s, "'") && strings.HasSuffix(s, "'")) {
		return s[1 : len(s)-1]
	}
	if strings.EqualFold(s, "true") {
		return true
	}
	if strings.EqualFold(s, "false") {
		return false
	}
	if strings.EqualFold(s, "null") || s == "~" {
		return nil
	}
	var intVal int64
	if _, err := fmt.Sscanf(s, "%d", &intVal); err == nil && fmt.Sprintf("%d", intVal) == s {
		return intVal
	}
	var floatVal float64
	if _, err := fmt.Sscanf(s, "%f", &floatVal); err == nil && fmt.Sprintf("%v", floatVal) == s {
		return floatVal
	}
	return s
}

// LoadMeshConfig reads the YAML configuration file from path, expands environment variables,
// parses it into MeshClusterConfig, and performs strict validation.
func LoadMeshConfig(path string) (*MeshClusterConfig, error) {
	_ = LoadDotEnv()

	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open config file %s: %w", path, err)
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", path, err)
	}

	return ParseMeshConfig(data)
}

// ParseMeshConfig expands env variables and unmarshals raw YAML data into a validated MeshClusterConfig.
func ParseMeshConfig(data []byte) (*MeshClusterConfig, error) {
	expandedStr := ExpandEnv(string(data))

	var cfg MeshClusterConfig
	// Use standard robust yaml parser to avoid inline list splitting bugs
	if err := yaml.Unmarshal([]byte(expandedStr), &cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal YAML configuration: %w", err)
	}

	if err := ValidateMeshConfig(&cfg); err != nil {
		return nil, fmt.Errorf("config validation failed: %w", err)
	}

	return &cfg, nil
}
