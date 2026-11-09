package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseUpArgs(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		want    upArgs
		wantErr string
	}{
		{name: "plain", args: []string{"gw.conf"}, want: upArgs{ProfilePath: "gw.conf"}},
		{name: "kill switch before", args: []string{"--kill-switch", "gw.conf"}, want: upArgs{ProfilePath: "gw.conf", KillSwitch: true}},
		{name: "kill switch after", args: []string{"gw.conf", "--kill-switch"}, want: upArgs{ProfilePath: "gw.conf", KillSwitch: true}},
		{name: "dash is a path", args: []string{"-"}, want: upArgs{ProfilePath: "-"}},
		{name: "missing path", args: []string{"--kill-switch"}, wantErr: "missing profile path"},
		{name: "no args", args: nil, wantErr: "missing profile path"},
		{name: "two paths", args: []string{"a.conf", "b.conf"}, wantErr: "want one profile path, got 2"},
		{name: "unknown flag", args: []string{"--dns=1.1.1.1", "gw.conf"}, wantErr: `unknown flag "--dns=1.1.1.1"`},
		{name: "repeated flag is harmless", args: []string{"--kill-switch", "--kill-switch", "gw.conf"}, want: upArgs{ProfilePath: "gw.conf", KillSwitch: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseUpArgs(tc.args)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestRunDispatch(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version"}, &out, &errOut); code != 0 || !strings.HasPrefix(out.String(), "neronet ") {
		t.Fatalf("version: code=%d out=%q err=%q", code, out.String(), errOut.String())
	}

	out.Reset()
	errOut.Reset()
	if code := run([]string{"up"}, &out, &errOut); code != 2 || !strings.Contains(errOut.String(), "missing profile path") {
		t.Fatalf("up without a profile: code=%d err=%q", code, errOut.String())
	}

	out.Reset()
	errOut.Reset()
	if code := run([]string{"frobnicate"}, &out, &errOut); code != 2 || !strings.Contains(errOut.String(), "unknown command") {
		t.Fatalf("unknown command: code=%d err=%q", code, errOut.String())
	}

	out.Reset()
	errOut.Reset()
	if code := run(nil, &out, &errOut); code != 2 || !strings.Contains(errOut.String(), "usage:") {
		t.Fatalf("no command: code=%d err=%q", code, errOut.String())
	}
}

func TestDownWithNothingRunningIsNotAnError(t *testing.T) {
	var out, errOut bytes.Buffer
	if err := runDown(t.TempDir(), &out, &errOut); err != nil {
		t.Fatalf("runDown: %v", err)
	}
	if !strings.Contains(out.String(), "not running") {
		t.Fatalf("out = %q", out.String())
	}
}

func TestStatusWithNothingRunningFails(t *testing.T) {
	var out bytes.Buffer
	err := runStatus(t.TempDir(), &out)
	if err == nil || err.Error() != "not running" {
		t.Fatalf("runStatus err = %v, want \"not running\"", err)
	}
}
