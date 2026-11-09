package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
)

// plistText is the launchd job for the system daemon: `neronet up <profile>` at boot, restarted
// only after a failure. `neronet down` sends SIGTERM and the daemon exits 0, so launchd does
// not bring it back.
func plistText(binary, profile string) string {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	b.WriteString(`<plist version="1.0">` + "\n<dict>\n")
	kv := func(key string, value string) {
		fmt.Fprintf(&b, "\t<key>%s</key>\n\t%s\n", key, value)
	}
	kv("Label", xmlString(daemonLabel))
	b.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, arg := range []string{binary, "up", profile} {
		fmt.Fprintf(&b, "\t\t%s\n", xmlString(arg))
	}
	b.WriteString("\t</array>\n")
	kv("RunAtLoad", "<true/>")
	kv("KeepAlive", "<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>")
	kv("ThrottleInterval", "<integer>10</integer>")
	kv("StandardOutPath", xmlString(logFile))
	kv("StandardErrorPath", xmlString(logFile))
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

func xmlString(s string) string {
	var b bytes.Buffer
	b.WriteString("<string>")
	_ = xml.EscapeText(&b, []byte(s))
	b.WriteString("</string>")
	return b.String()
}
