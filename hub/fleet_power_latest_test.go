package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bokiko/bloxos/proto/powerhistory"
)

func fpCurrent(t *testing.T, e interface {
	ServeHTTP(http.ResponseWriter, *http.Request)
}, token string) fleetPowerCurrent {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/fleet/power/current", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET current: %d %s", rec.Code, rec.Body.String())
	}
	var out fleetPowerCurrent
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, rec.Body.String())
	}
	return out
}

func fpCurrentDomain(t *testing.T, out fleetPowerCurrent, domain string) fleetPowerCurrentDomain {
	t.Helper()
	for _, d := range out.Domains {
		if d.Domain == domain {
			return d
		}
	}
	t.Fatalf("domain %q missing from current response", domain)
	return fleetPowerCurrentDomain{}
}

// The defect this endpoint exists to remove: a stale machine must not be
// carried into a current reading by a fresh one standing beside it.
func TestFleetPowerCurrentExcludesStaleMachinesFromTheSum(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	for _, id := range []string{"fresh", "dark"} {
		s.seedTestMachine(t, id)
	}

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "fresh", 1, now-30_000, now, fpSystem(100, powerhistory.SourceRAPLPsys))
	// Reported four hours ago and has said nothing since.
	old := now - 4*3_600_000
	insertFleetPowerRow(t, s, "dark", 1, old-30_000, old, fpSystem(900, powerhistory.SourceRAPLPsys))

	system := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if system.Measured.Watts == nil {
		t.Fatal("the fresh machine should still produce a current reading")
	}
	if got := *system.Measured.Watts; got != 100 {
		t.Fatalf("watts = %v, want 100 — the dark machine's 900 W must not be carried forward", got)
	}
	if system.Measured.Machines != 1 {
		t.Fatalf("machines = %d, want 1", system.Measured.Machines)
	}
}

// Nothing fresh anywhere is UNAVAILABLE, not zero. A fleet that went dark did
// not start drawing no power.
func TestFleetPowerCurrentIsUnavailableNotZeroWhenAllStale(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "dark")

	old := time.Now().UnixMilli() - 4*3_600_000
	insertFleetPowerRow(t, s, "dark", 1, old-30_000, old, fpSystem(900, powerhistory.SourceRAPLPsys))

	system := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if system.Measured.Watts != nil {
		t.Fatalf("a dark fleet reported %v W as current", *system.Measured.Watts)
	}
	if system.Measured.Machines != 0 {
		t.Fatalf("machines = %d, want 0", system.Measured.Machines)
	}
}

// The current answer must not change with the history period, because it is not
// drawn from the history window at all.
func TestFleetPowerCurrentIsIndependentOfHistoryPeriod(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "m1", 1, now-30_000, now, fpSystem(142, powerhistory.SourceRAPLPsys))

	base := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if base.Measured.Watts == nil {
		t.Fatal("expected a current reading")
	}

	// Ask the history endpoint for every period in turn; the current endpoint's
	// answer must be unmoved by any of it.
	for _, period := range []string{"30m", "1h", "6h", "24h"} {
		req := httptest.NewRequest(http.MethodGet, "/api/fleet/power/history?period="+period, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("history %s: %d", period, rec.Code)
		}

		again := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
		if again.Measured.Watts == nil {
			t.Fatalf("current went nil after asking history for %s", period)
		}
		if *again.Measured.Watts != *base.Measured.Watts {
			t.Fatalf("period %s changed the current reading: %v then %v",
				period, *base.Measured.Watts, *again.Measured.Watts)
		}
		if again.Measured.Machines != base.Measured.Machines {
			t.Fatalf("period %s changed the contributor count", period)
		}
	}
}

// Measured and modelled are reported side by side and never added.
func TestFleetPowerCurrentKeepsModelledSeparate(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	for _, id := range []string{"measured", "modelled"} {
		s.seedTestMachine(t, id)
	}

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "measured", 1, now-30_000, now, fpSystem(142, powerhistory.SourceRAPLPsys))
	insertFleetPowerRow(t, s, "modelled", 1, now-30_000, now, fpSystem(12, powerhistory.SourceEstimateUtil))

	system := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if system.Measured.Watts == nil || *system.Measured.Watts != 142 {
		t.Fatalf("measured = %v, want 142", system.Measured.Watts)
	}
	if system.Estimated.Watts == nil || *system.Estimated.Watts != 12 {
		t.Fatalf("estimated = %v, want 12", system.Estimated.Watts)
	}
	// 154 must appear nowhere: the two are different kinds of claim.
	if system.Measured.Machines != 1 || system.Estimated.Machines != 1 {
		t.Fatalf("machines measured=%d estimated=%d, want 1/1",
			system.Measured.Machines, system.Estimated.Machines)
	}
}

// A domain absent from a machine's latest window is unavailable for that
// machine. Reaching back to a previous window would revive a reading the
// machine has stopped producing.
func TestFleetPowerCurrentDoesNotReviveADomainTheLatestWindowLacks(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	now := time.Now().UnixMilli()
	// Older window HAS system power; the newest window does not.
	insertFleetPowerRow(t, s, "m1", 1, now-90_000, now-60_000, fpSystem(500, powerhistory.SourceRAPLPsys))
	insertFleetPowerRow(t, s, "m1", 2, now-30_000, now, powerhistory.Bucket{
		CPU: fpStats(40, 40, 30),
	})

	out := fpCurrent(t, e, token)
	system := fpCurrentDomain(t, out, powerhistory.DomainSystem)
	if system.Measured.Watts != nil {
		t.Fatalf("system revived a stopped reading: %v W", *system.Measured.Watts)
	}
	cpu := fpCurrentDomain(t, out, powerhistory.DomainCPU)
	if cpu.Measured.Watts == nil || *cpu.Measured.Watts != 40 {
		t.Fatalf("cpu = %v, want 40 — the domain the latest window does carry", cpu.Measured.Watts)
	}
}

// Unknown provenance is counted, never summed.
func TestFleetPowerCurrentCountsUnknownProvenanceWithoutSummingIt(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "m1", 1, now-30_000, now, fpSystem(77, "some-future-backend"))

	system := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if system.Measured.Watts != nil || system.Estimated.Watts != nil {
		t.Fatal("an unclassifiable backend was summed into a series")
	}
	if system.UnknownMachines != 1 {
		t.Fatalf("UnknownMachines = %d, want 1", system.UnknownMachines)
	}
}

// The "now" endpoint has to apply the same scope rule as the history, or the
// headline number and the chart disagree about what the fleet is drawing.
//
// These rows keep arriving: agents older than the change still send them, and
// journal replay delivers backlogs written before it.
func TestFleetPowerCurrentExcludesSystemReadingsOfUnverifiedScope(t *testing.T) {
	for _, source := range []string{
		powerhistory.SourceHwmonPrefix + "ina226",
		powerhistory.SourceHwmonPrefix + "power_meter",
		powerhistory.SourceBattery,
	} {
		t.Run(source, func(t *testing.T) {
			e, s := setupTestServer(t)
			s.markCredentialsRotated(t)
			token := loginAndGetToken(t, e)
			s.seedTestMachine(t, "m1")

			now := time.Now().UnixMilli()
			insertFleetPowerRow(t, s, "m1", 1, now-30_000, now, fpSystem(77, source))

			current := fpCurrent(t, e, token)
			system := fpCurrentDomain(t, current, powerhistory.DomainSystem)
			if system.Measured.Watts != nil {
				t.Fatalf("%s was summed into the current system total: %v W", source, *system.Measured.Watts)
			}
			if system.UnknownMachines != 1 {
				t.Fatalf("%s must be counted as excluded, got %d", source, system.UnknownMachines)
			}
			// It contributed nothing, so it is not a reporting machine.
			if current.MachinesReporting != 0 {
				t.Fatalf("MachinesReporting = %d; a machine excluded from every domain reports nothing",
					current.MachinesReporting)
			}
		})
	}

	// CONTROL: DCMI in the same position is summed, so the exclusions above
	// are about scope rather than about the endpoint refusing system power.
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")
	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "m1", 1, now-30_000, now, fpSystem(77, powerhistory.SourceIPMIDCMI))
	system := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if system.Measured.Watts == nil || *system.Measured.Watts != 77 {
		t.Fatalf("control: a DCMI reading must still be the current system total: %v", system.Measured.Watts)
	}
}

// The same classification rules on the "now" endpoint, or the headline number
// and the chart disagree about what the fleet is drawing.
func TestFleetPowerCurrentAppliesTheSameProvenanceRules(t *testing.T) {
	labelled := func(domain, source string, watts float64) powerhistory.Bucket {
		bk := powerhistory.Bucket{}
		st := fpStats(watts, watts, 30)
		switch domain {
		case powerhistory.DomainSystem:
			bk.System = st
		case powerhistory.DomainCPU:
			bk.CPU = st
		case powerhistory.DomainDRAM:
			bk.DRAM = st
		}
		if source != "" {
			bk.Sources = []powerhistory.DomainSource{{Domain: domain, Source: source}}
		}
		return bk
	}

	for _, tc := range []struct {
		name     string
		domain   string
		bucket   powerhistory.Bucket
		measured bool
	}{
		// Unlabelled System and DRAM match no agent that ever shipped.
		{"unlabelled system", powerhistory.DomainSystem, labelled(powerhistory.DomainSystem, "", 100), false},
		{"unlabelled system zero", powerhistory.DomainSystem, labelled(powerhistory.DomainSystem, "", 0), false},
		{"unlabelled dram", powerhistory.DomainDRAM, labelled(powerhistory.DomainDRAM, "", 12), false},
		// Unlabelled CPU is the legacy RAPL package sum.
		{"unlabelled cpu", powerhistory.DomainCPU, labelled(powerhistory.DomainCPU, "", 45), true},
		{"unlabelled cpu zero", powerhistory.DomainCPU, labelled(powerhistory.DomainCPU, "", 0), false},
		// A source must match the domain it measures.
		{"package as system", powerhistory.DomainSystem, labelled(powerhistory.DomainSystem, powerhistory.SourceRAPLPackage, 100), false},
		{"dcmi as cpu", powerhistory.DomainCPU, labelled(powerhistory.DomainCPU, powerhistory.SourceIPMIDCMI, 100), false},
		{"psys as system", powerhistory.DomainSystem, labelled(powerhistory.DomainSystem, powerhistory.SourceRAPLPsys, 100), true},
		{"package as cpu", powerhistory.DomainCPU, labelled(powerhistory.DomainCPU, powerhistory.SourceRAPLPackage, 100), true},
		{"dram as dram", powerhistory.DomainDRAM, labelled(powerhistory.DomainDRAM, powerhistory.SourceRAPLDRAM, 12), true},
		// A BMC reporting an active zero is a real reading.
		{"dcmi zero", powerhistory.DomainSystem, labelled(powerhistory.DomainSystem, powerhistory.SourceIPMIDCMI, 0), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, s := setupTestServer(t)
			s.markCredentialsRotated(t)
			token := loginAndGetToken(t, e)
			s.seedTestMachine(t, "m1")
			now := time.Now().UnixMilli()
			insertFleetPowerRow(t, s, "m1", 1, now-30_000, now, tc.bucket)

			d := fpCurrentDomain(t, fpCurrent(t, e, token), tc.domain)
			if tc.measured {
				if d.Measured.Watts == nil {
					t.Fatalf("%s must be a measured %s reading", tc.name, tc.domain)
				}
				return
			}
			if d.Measured.Watts != nil {
				t.Fatalf("%s was summed into the current %s total: %v W",
					tc.name, tc.domain, *d.Measured.Watts)
			}
			if d.UnknownMachines != 1 {
				t.Fatalf("%s must be counted as excluded, got %d", tc.name, d.UnknownMachines)
			}
		})
	}

	// A GPU parked at 0 W is a real reading and carries no scalar label.
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")
	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "m1", 1, now-30_000, now,
		powerhistory.Bucket{GPUTotal: fpStats(0, 0, 30)})
	gpu := fpCurrentDomain(t, fpCurrent(t, e, token), fleetPowerDomainGPU)
	if gpu.Measured.Watts == nil || *gpu.Measured.Watts != 0 {
		t.Fatalf("a GPU idling at 0 W must survive: %v", gpu.Measured.Watts)
	}
}

// A frozen RAPL window is not 0 W of CPU. The agent no longer produces one;
// the stored rows and older agents still do.
func TestFleetPowerCurrentFrozenRAPLWindowIsNotAValidZero(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	now := time.Now().UnixMilli()
	bk := powerhistory.Bucket{CPU: fpStats(0, 0, 30)}
	bk.Sources = []powerhistory.DomainSource{
		{Domain: powerhistory.DomainCPU, Source: powerhistory.SourceRAPLPackage},
	}
	insertFleetPowerRow(t, s, "m1", 1, now-30_000, now, bk)

	cpu := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainCPU)
	if cpu.Measured.Watts != nil {
		t.Fatalf("a frozen counter window became %v W of current CPU power", *cpu.Measured.Watts)
	}
	if cpu.UnknownMachines != 1 {
		t.Fatalf("UnknownMachines = %d, want 1", cpu.UnknownMachines)
	}
}

// The sum is only as current as its OLDEST contributor, and says so.
func TestFleetPowerCurrentReportsOldestContributor(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	for _, id := range []string{"a", "b"} {
		s.seedTestMachine(t, id)
	}

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "a", 1, now-30_000, now, fpSystem(100, powerhistory.SourceRAPLPsys))
	older := now - 100_000 // still inside the lookback, but not the newest
	insertFleetPowerRow(t, s, "b", 1, older-30_000, older, fpSystem(50, powerhistory.SourceRAPLPsys))

	system := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if system.Measured.Machines != 2 {
		t.Fatalf("machines = %d, want 2 — both are inside the lookback", system.Measured.Machines)
	}
	if system.Measured.OldestContributorEndUnixMS != older {
		t.Fatalf("oldest = %d, want %d", system.Measured.OldestContributorEndUnixMS, older)
	}
	if system.Measured.NewestContributorEndUnixMS != now {
		t.Fatalf("newest = %d, want %d", system.Measured.NewestContributorEndUnixMS, now)
	}
}

// The data-selection trap: a machine's NEWEST row is future-skewed while an
// older row looks perfectly fresh. Choosing candidates before classifying would
// pick the older row and present a superseded reading as current.
func TestFleetPowerCurrentDoesNotFallBackPastASkewedNewestRow(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	now := time.Now().UnixMilli()
	// An older, entirely plausible reading.
	insertFleetPowerRow(t, s, "m1", 1, now-60_000, now-30_000, fpSystem(100, powerhistory.SourceRAPLPsys))
	// The newest row is stamped well ahead of the hub clock.
	future := now + 600_000
	insertFleetPowerRow(t, s, "m1", 2, future-30_000, future, fpSystem(900, powerhistory.SourceRAPLPsys))

	system := fpCurrentDomain(t, fpCurrent(t, e, token), powerhistory.DomainSystem)
	if system.Measured.Watts != nil {
		t.Fatalf("fell back past a skewed newest row and reported %v W", *system.Measured.Watts)
	}
	if system.SkewedMachines != 1 {
		t.Fatalf("SkewedMachines = %d, want 1 — the skew must be counted, not filtered away", system.SkewedMachines)
	}
}

// A machine whose only history is stale must be COUNTED as stale, not vanish.
func TestFleetPowerCurrentCountsAStaleOnlyMachine(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	old := time.Now().UnixMilli() - 3_600_000
	insertFleetPowerRow(t, s, "m1", 1, old-30_000, old, fpSystem(100, powerhistory.SourceRAPLPsys))

	out := fpCurrent(t, e, token)
	system := fpCurrentDomain(t, out, powerhistory.DomainSystem)
	if system.StaleMachines != 1 {
		t.Fatalf("StaleMachines = %d, want 1", system.StaleMachines)
	}
	if system.Measured.Watts != nil {
		t.Fatal("a stale-only machine must contribute no watts")
	}
	if out.MachinesReporting != 0 {
		t.Fatalf("MachinesReporting = %d, want 0 — a row on disk is not a report", out.MachinesReporting)
	}
}

// MachinesReporting counts fresh valid classifiable readings, so a machine whose
// only reading is unclassifiable is not counted as reporting.
func TestFleetPowerCurrentUnknownOnlyMachineIsNotReporting(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "m1", 1, now-30_000, now, fpSystem(77, "some-future-backend"))

	out := fpCurrent(t, e, token)
	system := fpCurrentDomain(t, out, powerhistory.DomainSystem)
	if system.UnknownMachines != 1 {
		t.Fatalf("UnknownMachines = %d, want 1", system.UnknownMachines)
	}
	if out.MachinesReporting != 0 {
		t.Fatalf("MachinesReporting = %d, want 0 — unclassified is not a reading", out.MachinesReporting)
	}
}

// A corrupt newest row makes the machine unavailable. It must NOT quietly fall
// back to an older row, which would answer "now" with superseded data.
func TestFleetPowerCurrentCorruptNewestRowIsUnavailableNotAFallback(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "m1", 1, now-60_000, now-30_000, fpSystem(100, powerhistory.SourceRAPLPsys))
	if _, err := s.db.Exec(`INSERT INTO power_history_records
		(machine_id, stream_id, seq, start_unix_ms, end_unix_ms, expected_samples, payload)
		VALUES (?, 'stream-1', ?, ?, ?, 30, ?)`,
		"m1", 2, now-30_000, now, "{not valid json"); err != nil {
		t.Fatalf("insert corrupt row: %v", err)
	}

	out := fpCurrent(t, e, token)
	system := fpCurrentDomain(t, out, powerhistory.DomainSystem)
	if system.Measured.Watts != nil {
		t.Fatalf("a corrupt newest row revived an older reading: %v W", *system.Measured.Watts)
	}
	if out.MachinesUnreadable != 1 {
		t.Fatalf("MachinesUnreadable = %d, want 1", out.MachinesUnreadable)
	}
	if out.MachinesReporting != 0 {
		t.Fatalf("MachinesReporting = %d, want 0", out.MachinesReporting)
	}
}

// Orphaned rows for a machine no longer registered must not appear at all.
func TestFleetPowerCurrentIgnoresOrphanedRecords(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "registered")

	now := time.Now().UnixMilli()
	insertFleetPowerRow(t, s, "registered", 1, now-30_000, now, fpSystem(100, powerhistory.SourceRAPLPsys))

	out := fpCurrent(t, e, token)
	if out.MachinesTotal != 1 {
		t.Fatalf("MachinesTotal = %d, want 1", out.MachinesTotal)
	}
	if out.MachinesReporting != 1 {
		t.Fatalf("MachinesReporting = %d, want 1", out.MachinesReporting)
	}
	if out.MachinesReporting > out.MachinesTotal {
		t.Fatal("reporting exceeded the fleet size")
	}
}

// A broken read must not become a confident "nothing is reporting". This is the
// alert-count defect in another costume: a failed query rendered as a number.
func TestFleetPowerCurrentFailsLoudlyWhenTheQueryBreaks(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	s.seedTestMachine(t, "m1")

	// The machines table stays readable; the power history does not.
	if _, err := s.db.Exec(`DROP TABLE power_history_records`); err != nil {
		t.Fatalf("drop table: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/fleet/power/current", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatalf("a failed power query returned 200 and a snapshot: %s", rec.Body.String())
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

// Reading fleet power requires fleet.read like every other power route.
func TestFleetPowerCurrentRequiresAuth(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)

	req := httptest.NewRequest(http.MethodGet, "/api/fleet/power/current", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET: %d, want 401", rec.Code)
	}
}

// fpMachine picks one machine's row out of the current snapshot.
func fpMachine(t *testing.T, out fleetPowerCurrent, id string) fleetPowerCurrentMachine {
	t.Helper()
	for _, m := range out.Machines {
		if m.MachineID == id {
			return m
		}
	}
	t.Fatalf("no row for %q; got %d rows", id, len(out.Machines))
	return fleetPowerCurrentMachine{}
}

// The per-machine rows are the SAME decisions the totals are built from, not a
// second answer. A row that disagreed with the total it feeds would be two
// views of one fact, disagreeing, with nothing to say which was right — the
// exact failure the fleet power endpoint was written to avoid.
func TestFleetPowerCurrentRowsAgreeWithTheTotalsTheyFeed(t *testing.T) {
	e, s := setupTestServer(t)
	s.markCredentialsRotated(t)
	token := loginAndGetToken(t, e)
	now := time.Now().UnixMilli()

	labelled := func(domain, source string, watts float64) powerhistory.Bucket {
		bk := powerhistory.Bucket{}
		st := fpStats(watts, watts, 30)
		switch domain {
		case powerhistory.DomainSystem:
			bk.System = st
		case powerhistory.DomainCPU:
			bk.CPU = st
		}
		if source != "" {
			bk.Sources = []powerhistory.DomainSource{{Domain: domain, Source: source}}
		}
		return bk
	}

	// Three machines: one measured, one modelled, one excluded for scope.
	s.seedTestMachine(t, "measured-1")
	insertFleetPowerRow(t, s, "measured-1", 1, now-30_000, now,
		labelled(powerhistory.DomainSystem, powerhistory.SourceIPMIDCMI, 100))
	s.seedTestMachine(t, "modelled-1")
	insertFleetPowerRow(t, s, "modelled-1", 1, now-30_000, now,
		labelled(powerhistory.DomainSystem, powerhistory.SourceEstimateUtil, 18))
	s.seedTestMachine(t, "battery-1")
	insertFleetPowerRow(t, s, "battery-1", 1, now-30_000, now,
		labelled(powerhistory.DomainSystem, powerhistory.SourceBattery, 23))
	// And one registered machine that has never stored a window.
	s.seedTestMachine(t, "silent-1")

	out := fpCurrent(t, e, token)
	system := fpCurrentDomain(t, out, powerhistory.DomainSystem)

	// Every registered machine has a row: a silent machine is an answer.
	if len(out.Machines) != 4 {
		t.Fatalf("rows = %d, want one per registered machine", len(out.Machines))
	}
	for i := 1; i < len(out.Machines); i++ {
		if out.Machines[i-1].MachineID > out.Machines[i].MachineID {
			t.Fatal("rows must be ordered; map iteration order is not an API")
		}
	}

	// Sum the rows the way an operator would read them, and require the same
	// numbers the aggregate reports.
	var measuredSum, modelledSum float64
	var measuredCount, modelledCount, excluded int
	for _, m := range out.Machines {
		r := m.Domains[powerhistory.DomainSystem]
		switch {
		case r.Watts != nil && r.Kind == fleetPowerKindMeasured:
			measuredSum += *r.Watts
			measuredCount++
		case r.Watts != nil && r.Kind == fleetPowerKindEstimated:
			modelledSum += *r.Watts
			modelledCount++
		case r.Reason == fleetPowerReasonScopeUnverified || r.Reason == fleetPowerReasonSourceUnverified ||
			r.Reason == fleetPowerReasonCounterIdle:
			excluded++
		}
	}
	if system.Measured.Watts == nil || *system.Measured.Watts != measuredSum {
		t.Fatalf("measured total %v disagrees with the rows' sum %v", system.Measured.Watts, measuredSum)
	}
	if system.Measured.Machines != measuredCount {
		t.Fatalf("measured contributors %d, rows %d", system.Measured.Machines, measuredCount)
	}
	if system.Estimated.Watts == nil || *system.Estimated.Watts != modelledSum {
		t.Fatalf("modelled total %v disagrees with the rows' sum %v", system.Estimated.Watts, modelledSum)
	}
	if system.UnknownMachines != excluded {
		t.Fatalf("excluded count %d, rows %d", system.UnknownMachines, excluded)
	}

	// The rows themselves say the right things.
	battery := fpMachine(t, out, "battery-1").Domains[powerhistory.DomainSystem]
	if battery.Reason != fleetPowerReasonScopeUnverified || battery.Watts != nil {
		t.Fatalf("battery row: %+v", battery)
	}
	if battery.Source != powerhistory.SourceBattery {
		t.Fatalf("an excluded row must still name what it was: %q", battery.Source)
	}
	modelled := fpMachine(t, out, "modelled-1").Domains[powerhistory.DomainSystem]
	if modelled.Kind != fleetPowerKindEstimated {
		t.Fatalf("the wire spelling stays 'estimated': %q", modelled.Kind)
	}

	silent := fpMachine(t, out, "silent-1")
	if silent.WindowEndUnixMS != 0 {
		t.Fatalf("a machine with no stored window has no window end: %d", silent.WindowEndUnixMS)
	}
	for _, domain := range fleetPowerDomains {
		if r := silent.Domains[domain]; r.Reason != fleetPowerReasonAbsent || r.Watts != nil {
			t.Fatalf("silent machine %s: %+v", domain, r)
		}
	}

	// Every row carries an answer for every domain, so a client never has to
	// tell "absent" apart from "the endpoint forgot".
	for _, m := range out.Machines {
		if len(m.Domains) != len(fleetPowerDomains) {
			t.Fatalf("%s has %d domains, want %d", m.MachineID, len(m.Domains), len(fleetPowerDomains))
		}
		for _, r := range m.Domains {
			if (r.Watts == nil) == (r.Reason == "") {
				t.Fatalf("%s: exactly one of watts and reason must be set: %+v", m.MachineID, r)
			}
		}
	}

	// The window end is the AGENT's, which is what a client ages against.
	measured := fpMachine(t, out, "measured-1")
	if measured.WindowEndUnixMS != now {
		t.Fatalf("window end %d, want the agent's own %d", measured.WindowEndUnixMS, now)
	}
}

// A stale or skewed machine must say so per domain, not vanish from the rows.
func TestFleetPowerCurrentRowsExplainStaleAndSkew(t *testing.T) {
	for _, tc := range []struct {
		name   string
		offset int64
		reason string
	}{
		{"stale", -10 * 60_000, fleetPowerReasonStale},
		{"skewed", 10 * 60_000, fleetPowerReasonSkew},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, s := setupTestServer(t)
			s.markCredentialsRotated(t)
			token := loginAndGetToken(t, e)
			s.seedTestMachine(t, "m1")
			end := time.Now().UnixMilli() + tc.offset
			insertFleetPowerRow(t, s, "m1", 1, end-30_000, end, fpSystem(100, powerhistory.SourceIPMIDCMI))

			out := fpCurrent(t, e, token)
			row := fpMachine(t, out, "m1")
			r := row.Domains[powerhistory.DomainSystem]
			if r.Reason != tc.reason || r.Watts != nil {
				t.Fatalf("%s row: %+v", tc.name, r)
			}
			// The window end is still reported, so the age is recoverable.
			if row.WindowEndUnixMS != end {
				t.Fatalf("window end %d, want %d — the timestamp is the useful part",
					row.WindowEndUnixMS, end)
			}
		})
	}
}
