package main

import (
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func TestPlistIsWellFormedAndComplete(t *testing.T) {
	text := plistText(binaryFile, profileFile)

	dec := xml.NewDecoder(strings.NewReader(text))
	for {
		_, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("plist is not well-formed XML: %v\n%s", err, text)
		}
	}

	wants := []string{
		"<string>com.darknero.neronet</string>",
		"<string>/Library/Application Support/NeroNet/neronet</string>",
		"<string>up</string>",
		"<string>/Library/Application Support/NeroNet/profile.conf</string>",
		"<key>RunAtLoad</key>\n\t<true/>",
		"<key>SuccessfulExit</key>\n\t\t<false/>",
		"<string>/var/log/neronet.log</string>",
	}
	for _, w := range wants {
		if !strings.Contains(text, w) {
			t.Errorf("plist lacks %q\n%s", w, text)
		}
	}
	if !strings.Contains(text, "<key>Label</key>") {
		t.Error("plist has no Label key")
	}
}

func TestPlistPathIsDaemonLocation(t *testing.T) {
	if plistPath != "/Library/LaunchDaemons/com.darknero.neronet.plist" {
		t.Fatalf("plistPath = %q", plistPath)
	}
	if !strings.Contains(plistText(binaryFile, profileFile), "<string>"+daemonLabel+"</string>") {
		t.Fatal("plist Label does not match daemonLabel")
	}
}

func TestPlistEscapesSpecialCharacters(t *testing.T) {
	text := plistText("/opt/a&b/<neronet>", "/tmp/p's.conf")
	if !strings.Contains(text, "<string>/opt/a&amp;b/&lt;neronet&gt;</string>") {
		t.Errorf("binary path not escaped:\n%s", text)
	}
	if !strings.Contains(text, "<string>/tmp/p&#39;s.conf</string>") {
		t.Errorf("profile path not escaped:\n%s", text)
	}
	dec := xml.NewDecoder(strings.NewReader(text))
	for {
		_, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("escaped plist is not well-formed: %v", err)
		}
	}
}
