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
