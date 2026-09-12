package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/bokiko/bloxos/proto/powerhistory"
)

// The hub half of the shared classification corpus.
//
// The dashboard reads the same file (dashboard/src/lib/power-cell.test.mjs).
// The hub decides what may be TOTALLED and the dashboard decides what may be
// DRAWN, and those two policies have to agree — so they are checked against
// one list of cases rather than two matrices maintained in parallel. Two
// copies do not detect divergence; they just both exist.

type classificationCase struct {
	Name    string   `json:"name"`
	Why     string   `json:"why"`
	Domain  string   `json:"domain"`
	Source  string   `json:"source"`
	Mean    *float64 `json:"mean"`
	Peak    *float64 `json:"peak"`
	Samples int      `json:"samples"`
	Kind    string   `json:"kind"`
}

func loadClassificationCorpus(t *testing.T) []classificationCase {
	t.Helper()
	path := filepath.Join("..", "proto", "powerhistory", "testdata", "classification.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the shared corpus: %v", err)
	}
	var doc struct {
		Cases []classificationCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse the shared corpus: %v", err)
	}
	// A corpus that failed to load would make every assertion below vacuous.
	if len(doc.Cases) < 20 {
		t.Fatalf("the shared corpus has only %d cases; it is not being read", len(doc.Cases))
	}
	return doc.Cases
}

func TestFleetPowerClassificationMatchesTheSharedCorpus(t *testing.T) {
	cases := loadClassificationCorpus(t)
	kinds := map[string]bool{}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			stats := &powerhistory.Stats{
				MeanWatts: tc.Mean, PeakWatts: tc.Peak, Samples: tc.Samples,
			}
			got := fleetPowerKindFor(tc.Domain, tc.Source, stats)
			if got != tc.Kind {
				detail := tc.Why
				if detail == "" {
					detail = "see proto/powerhistory/testdata/classification.json"
				}
				t.Fatalf("%s/%q classified as %q, corpus says %q — %s",
					tc.Domain, tc.Source, got, tc.Kind, detail)
			}
		})
		kinds[tc.Kind] = true
	}
	// All three outcomes must be exercised, or the corpus has drifted into
	// testing one branch.
	for _, kind := range []string{fleetPowerKindMeasured, fleetPowerKindEstimated, fleetPowerKindUnknown} {
		if !kinds[kind] {
			t.Fatalf("the corpus contains no %q case", kind)
		}
	}
}

// An excluded reading must name the gate that actually rejected it.
//
// A zero-valued rapl-package reading in the SYSTEM domain was refused for
// being a package sum wearing a whole-machine label, not for idling. Calling
// it an idle counter sends an operator to the hardware for a problem that is
// in the labelling.
func TestFleetPowerUnknownReasonNamesTheGateThatRejected(t *testing.T) {
	zero, positive := 0.0, 60.0
	zeroStats := &powerhistory.Stats{MeanWatts: &zero, PeakWatts: &zero, Samples: 30}
	liveStats := &powerhistory.Stats{MeanWatts: &positive, PeakWatts: &positive, Samples: 30}

	for _, tc := range []struct {
		name           string
		domain, source string
		stats          *powerhistory.Stats
		want           string
	}{
		{"a mismatched source, at zero", powerhistory.DomainSystem, powerhistory.SourceRAPLPackage,
			zeroStats, fleetPowerReasonSourceUnverified},
		{"a mismatched source, live", powerhistory.DomainSystem, powerhistory.SourceRAPLPackage,
			liveStats, fleetPowerReasonSourceUnverified},
		{"a mismatched source in cpu, at zero", powerhistory.DomainCPU, powerhistory.SourceIPMIDCMI,
			zeroStats, fleetPowerReasonSourceUnverified},
		{"an unlabelled system reading, at zero", powerhistory.DomainSystem, "",
			zeroStats, fleetPowerReasonSourceUnverified},
		{"an unrecognised backend", powerhistory.DomainSystem, "some-future-backend",
			liveStats, fleetPowerReasonSourceUnverified},

		{"a battery is a scope question", powerhistory.DomainSystem, powerhistory.SourceBattery,
			liveStats, fleetPowerReasonScopeUnverified},
		{"a shunt is a scope question", powerhistory.DomainSystem,
			powerhistory.SourceHwmonPrefix + "ina226", liveStats, fleetPowerReasonScopeUnverified},
		{"scope is decided before the zero check", powerhistory.DomainSystem,
			powerhistory.SourceBattery, zeroStats, fleetPowerReasonScopeUnverified},

		// Only a reading that passed classification can be refused for idling.
		{"a matched source at zero really is the idle case", powerhistory.DomainCPU,
			powerhistory.SourceRAPLPackage, zeroStats, fleetPowerReasonCounterIdle},
		{"psys at zero in its own domain", powerhistory.DomainSystem, powerhistory.SourceRAPLPsys,
			zeroStats, fleetPowerReasonCounterIdle},
		{"an unlabelled legacy CPU zero", powerhistory.DomainCPU, "",
			zeroStats, fleetPowerReasonCounterIdle},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := fleetPowerUnknownReason(tc.domain, tc.source, tc.stats); got != tc.want {
				t.Fatalf("%s/%q reported %q, want %q", tc.domain, tc.source, got, tc.want)
			}
		})
	}
}
