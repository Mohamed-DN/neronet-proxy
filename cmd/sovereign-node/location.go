package main

import (
	"flag"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/config"
	"github.com/sovereign/proxy/v4/pkg/control"
)

// declaredLocation is the position the operator states for this node. Nothing on the
// node measures where it is, so the control plane stores these values as declared and
// never as fact. A field the operator left empty stays absent on the wire.
type declaredLocation struct {
	City      string
	Latitude  *float64
	Longitude *float64
}

// bindLocationFlags registers -city, -lat and -lon (env SOVEREIGN_CITY, SOVEREIGN_LAT,
// SOVEREIGN_LON) and returns a function that reads and validates them after the flag
// set has been parsed.
func bindLocationFlags(fs *flag.FlagSet) func() (declaredLocation, error) {
	city := config.BindStringFlag(fs, "city", "SOVEREIGN_CITY", "", "Self-declared city for bridge registration (not measured); empty means not reported")
	lat := config.BindStringFlag(fs, "lat", "SOVEREIGN_LAT", "", "Self-declared latitude in degrees (not measured); needs -lon; empty means not reported")
	lon := config.BindStringFlag(fs, "lon", "SOVEREIGN_LON", "", "Self-declared longitude in degrees (not measured); needs -lat; empty means not reported")

	return func() (declaredLocation, error) {
		return parseDeclaredLocation(*city, *lat, *lon)
	}
}

// parseDeclaredLocation validates the -city, -lat and -lon values.
//
// Latitude and longitude are accepted only as a pair: half a coordinate places the
// node nowhere, and a silent 0 for the missing half would place it in the Gulf of
// Guinea. A value that does not parse, or is out of range, is an error rather than a
// silently dropped field, so a typo in a deployment file is seen at start-up.
func parseDeclaredLocation(city, lat, lon string) (declaredLocation, error) {
	loc := declaredLocation{City: strings.TrimSpace(city)}

	lat = strings.TrimSpace(lat)
	lon = strings.TrimSpace(lon)
	if lat == "" && lon == "" {
		return loc, nil
	}
	if lat == "" || lon == "" {
		return declaredLocation{}, fmt.Errorf("-lat and -lon must be given together")
	}

	latitude, err := parseCoordinate("latitude", lat, 90)
	if err != nil {
		return declaredLocation{}, err
	}
	longitude, err := parseCoordinate("longitude", lon, 180)
	if err != nil {
		return declaredLocation{}, err
	}

	loc.Latitude = &latitude
	loc.Longitude = &longitude
	return loc, nil
}

func parseCoordinate(name, raw string, limit float64) (float64, error) {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("%s %q is not a number", name, raw)
	}
	if value < -limit || value > limit {
		return 0, fmt.Errorf("%s %v is outside [-%v, %v]", name, value, limit, limit)
	}
	return value, nil
}

// withLocation returns the capability with the declared position filled in.
func withLocation(cap control.CapabilityDesc, loc declaredLocation) control.CapabilityDesc {
	cap.City = loc.City
	cap.Latitude = loc.Latitude
	cap.Longitude = loc.Longitude
	return cap
}
